import { randomUUID } from "node:crypto"

import { assertAllowedRepository, type RuntimeConfig } from "./config.js"
import {
  GitHubApiError,
  GitHubPreconditionError,
  GitHubPublishedPostconditionError,
  type VerifiedRelease,
} from "./github.js"
import {
  LedgerError,
  type LedgerIdentity,
  type OperationLedger,
} from "./ledger.js"
import { NotionPacketError } from "./notion.js"
import {
  assertReceipt,
  buildIdentity,
  PolicyError,
  sha256,
  validateInput,
} from "./policy.js"
import type {
  OperationState,
  PublishPreparedReleaseInput,
  PublishReceipt,
  ReceiptRecord,
  ReceiptStep,
  ReleaseRecord,
} from "./types.js"

type Clock = () => string

export type PublishOrchestratorOptions = {
  github: GitHubOperations
  ledger: OperationLedger
  notion: NotionPacketOperations
  config: RuntimeConfig
  now?: Clock
  leaseToken?: () => string
}

export type GitHubOperations = {
  verifyPreparedRelease(
    input: PublishPreparedReleaseInput,
    expectedRepositoryId: number,
    options?: {
      verifyGates: boolean
      verifyLatest?: boolean
      expectedPublishedRecord?: ReleaseRecord | null
    }
  ): Promise<VerifiedRelease>
  publishAndReconcile(
    input: PublishPreparedReleaseInput,
    expectedRepositoryId: number
  ): Promise<{
    release: VerifiedRelease
    reconciledAfterAmbiguousResponse: boolean
  }>
}

export type NotionPacketOperations = {
  verify(input: PublishPreparedReleaseInput): Promise<unknown>
  writeReceipt(
    input: PublishPreparedReleaseInput,
    receiptJson: string,
    options?: { requireApproved?: boolean }
  ): Promise<{ changed: boolean; pageId: string; url: string }>
}

function step(
  name: string,
  status: ReceiptStep["status"],
  detail: string
): ReceiptStep {
  return { name, status, detail: detail.slice(0, 300) }
}

function releaseRecord(
  record: ReleaseRecord,
  action: "published" | "observed"
): ReceiptRecord {
  return {
    system: "github",
    kind: "release",
    id: String(record.releaseId),
    url: record.url,
    action,
  }
}

function notionRecord(pageId: string, url: string): ReceiptRecord {
  return {
    system: "notion",
    kind: "release_packet",
    id: pageId,
    url,
    action: "receipt_written",
  }
}

function receiptJson(identity: LedgerIdentity, release: ReleaseRecord): string {
  return JSON.stringify({
    version: 1,
    operationId: identity.operationId,
    idempotencyKey: identity.idempotencyKey,
    repository: release.repository,
    repositoryId: release.repositoryId,
    releaseId: release.releaseId,
    releaseUrl: release.url,
    tag: release.tag,
    targetCommit: release.targetCommit,
    nameSha256: release.nameSha256,
    bodySha256: release.bodySha256,
    publishedAt: release.publishedAt,
  })
}

function rejectedIdentity(input: PublishPreparedReleaseInput): LedgerIdentity {
  const digest = sha256(
    [
      String(input.repository).slice(0, 120),
      String(input.releaseId).slice(0, 30),
      String(input.approvalPageId).slice(0, 80),
      String(input.approvalRevision).slice(0, 160),
    ].join(":")
  )
  return {
    idempotencyKey: `rejected:${digest}`,
    operationId: `ghrel_rejected_${digest.slice(0, 16)}`,
    inputFingerprint: digest,
    resourceKey: `rejected:${digest}`,
  }
}

function baseReceipt(
  identity: LedgerIdentity,
  values: Partial<PublishReceipt> & Pick<PublishReceipt, "status">
): PublishReceipt {
  const { status, ...overrides } = values
  const result: PublishReceipt = {
    ok: status === "completed" || status === "no_op",
    status,
    operationId: identity.operationId,
    idempotencyKey: identity.idempotencyKey,
    changed: false,
    replay: false,
    published: false,
    records: [],
    steps: [],
    warnings: [],
    retryable: false,
    resumeToken: null,
    repair: null,
    ...overrides,
  }
  assertReceipt(result)
  return result
}

function replayReceipt(state: OperationState): PublishReceipt {
  if (!state.receipt) {
    throw new LedgerError(
      "Completed operation is missing its canonical receipt"
    )
  }
  return baseReceipt(
    {
      operationId: state.operationId,
      idempotencyKey: state.idempotencyKey,
      inputFingerprint: state.inputFingerprint,
      resourceKey: `completed:${state.idempotencyKey}`,
    },
    {
      ...state.receipt,
      status: "no_op",
      ok: true,
      changed: false,
      replay: true,
      retryable: false,
      resumeToken: null,
      repair: null,
      steps: [
        step("replay", "completed", "Returned durable completed operation"),
      ],
    }
  )
}

function matchingState(state: OperationState, identity: LedgerIdentity): void {
  if (
    state.operationId !== identity.operationId ||
    state.idempotencyKey !== identity.idempotencyKey ||
    state.inputFingerprint !== identity.inputFingerprint
  ) {
    throw new LedgerError(
      "Durable operation state belongs to a different input"
    )
  }
}

export class PublishPreparedReleaseOrchestrator {
  private readonly now: Clock
  private readonly leaseToken: () => string

  constructor(private readonly options: PublishOrchestratorOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.leaseToken = options.leaseToken ?? randomUUID
  }

  async execute(input: PublishPreparedReleaseInput): Promise<PublishReceipt> {
    let publicationAttempted = false
    let identity: LedgerIdentity
    let repositoryId: number
    try {
      validateInput(input)
      const allowed = assertAllowedRepository(
        input.repository,
        this.options.config.allowedRepositories
      )
      repositoryId = allowed.repositoryId
      identity = buildIdentity(input, repositoryId)
    } catch (error) {
      identity = rejectedIdentity(input)
      return baseReceipt(identity, {
        status: "conflict",
        steps: [step("input_policy", "failed", safeMessage(error))],
        repair:
          "Use the exact approved, bounded packet and recalculate its fingerprint.",
      })
    }

    let durable: OperationState | null
    try {
      durable = await this.options.ledger.readState(identity)
      if (durable) matchingState(durable, identity)
      if (durable?.stage === "completed") return replayReceipt(durable)
    } catch (error) {
      return baseReceipt(identity, {
        status: "blocked",
        steps: [step("operation_ledger", "failed", safeMessage(error))],
        retryable: true,
        repair:
          "Restore the Redis operation ledger, then retry the identical input.",
      })
    }

    const token = this.leaseToken()
    let ownsLease = false
    try {
      const claim = await this.options.ledger.acquireLease(identity, token)
      ownsLease = claim.acquired
      if (!claim.acquired) {
        const afterClaim = await this.options.ledger.readState(identity)
        if (afterClaim) matchingState(afterClaim, identity)
        if (afterClaim?.stage === "completed") return replayReceipt(afterClaim)
        return baseReceipt(identity, {
          status: "conflict",
          steps: [
            step(
              "operation_lease",
              "failed",
              "Another invocation owns this exact operation"
            ),
          ],
          retryable: true,
          resumeToken: `ghrel_resume_${sha256(`resume:${identity.idempotencyKey.replace("github-release:", "")}`).slice(0, 24)}`,
          repair:
            claim.retryAfterSeconds === null
              ? "Retry the identical input after the active invocation finishes."
              : `Retry the identical input after at least ${claim.retryAfterSeconds} seconds.`,
        })
      }

      durable = await this.options.ledger.readState(identity)
      if (durable) matchingState(durable, identity)
      if (durable?.stage === "completed") return replayReceipt(durable)

      if (durable?.stage === "published") {
        return await this.resumeReceiptOnly(
          input,
          identity,
          repositoryId,
          durable,
          token
        )
      }

      const claimed: OperationState = durable ?? {
        version: 1,
        operationId: identity.operationId,
        idempotencyKey: identity.idempotencyKey,
        inputFingerprint: identity.inputFingerprint,
        stage: "claimed",
        release: null,
        receipt: null,
        receiptJson: null,
        updatedAt: this.now(),
      }
      await this.options.ledger.putState(identity, claimed)

      const steps: ReceiptStep[] = []
      await this.options.notion.verify(input)
      steps.push(
        step("approval_preflight", "completed", "Notion approval matched")
      )
      const first = await this.options.github.verifyPreparedRelease(
        input,
        repositoryId
      )
      steps.push(
        step(
          "github_preflight",
          "completed",
          `Exact release, tag, target, assets, and ${input.requiredChecks.length} gates matched`
        )
      )

      if (first.state === "published") {
        return await this.completePublished(
          input,
          identity,
          first,
          steps,
          true,
          false
        )
      }

      if (!(await this.options.ledger.renewLease(identity, token))) {
        return baseReceipt(identity, {
          status: "conflict",
          steps: [
            ...steps,
            step(
              "operation_lease",
              "failed",
              "Lease ownership expired before final reads"
            ),
          ],
          retryable: true,
          repair: "Retry the identical input; no publication was attempted.",
        })
      }

      // Re-read every authoritative approval and provider precondition directly
      // before the single consequential PATCH.
      await this.options.notion.verify(input)
      const finalPrecondition = await this.options.github.verifyPreparedRelease(
        input,
        repositoryId
      )
      if (finalPrecondition.state !== "draft") {
        return await this.completePublished(
          input,
          identity,
          finalPrecondition,
          [
            ...steps,
            step(
              "final_preconditions",
              "completed",
              "Publication already observed"
            ),
          ],
          true,
          false
        )
      }
      steps.push(
        step(
          "final_preconditions",
          "completed",
          "Approval and GitHub state matched immediately before publication"
        )
      )

      if (!(await this.options.ledger.renewLease(identity, token))) {
        return baseReceipt(identity, {
          status: "conflict",
          steps: [
            ...steps,
            step(
              "operation_lease",
              "failed",
              "Lease ownership expired during final provider reads"
            ),
          ],
          retryable: true,
          repair: "Retry the identical input; no publication was attempted.",
        })
      }

      publicationAttempted = true
      const published = await this.options.github.publishAndReconcile(
        input,
        repositoryId
      )
      steps.push(
        step(
          "publish_release",
          "completed",
          published.reconciledAfterAmbiguousResponse
            ? "Publication confirmed by read-back after an ambiguous response"
            : "Publication confirmed by authoritative read-back"
        )
      )
      return await this.completePublished(
        input,
        identity,
        published.release,
        steps,
        false,
        true
      )
    } catch (error) {
      return this.failureReceipt(identity, error, publicationAttempted)
    } finally {
      if (ownsLease) {
        // A token-checked EVAL prevents one invocation from deleting another's
        // renewed lease. Failure is bounded by the TTL and cannot authorize work.
        await this.options.ledger.releaseLease(identity, token).catch(() => {})
      }
    }
  }

  private async resumeReceiptOnly(
    input: PublishPreparedReleaseInput,
    identity: LedgerIdentity,
    repositoryId: number,
    durable: OperationState,
    token: string
  ): Promise<PublishReceipt> {
    if (!durable.release || !durable.receiptJson) {
      throw new LedgerError(
        "Published operation is missing release or receipt state"
      )
    }
    if (!(await this.options.ledger.renewLease(identity, token))) {
      return baseReceipt(identity, {
        status: "conflict",
        published: true,
        records: [releaseRecord(durable.release, "observed")],
        steps: [step("operation_lease", "failed", "Lease ownership expired")],
        retryable: true,
        repair: "Retry the identical input to finish Notion receipt writeback.",
      })
    }
    const verified = await this.options.github.verifyPreparedRelease(
      input,
      repositoryId,
      {
        verifyGates: false,
        verifyLatest: false,
        expectedPublishedRecord: durable.release,
      }
    )
    if (verified.state !== "published") {
      throw new GitHubPreconditionError(
        "Durable state says published but GitHub no longer shows the release"
      )
    }
    return this.completePublished(
      input,
      identity,
      verified,
      [
        step(
          "resume",
          "completed",
          "Skipped publication from durable published state"
        ),
      ],
      true,
      false
    )
  }

  private async completePublished(
    input: PublishPreparedReleaseInput,
    identity: LedgerIdentity,
    verified: VerifiedRelease,
    priorSteps: ReceiptStep[],
    replay: boolean,
    releaseChanged: boolean
  ): Promise<PublishReceipt> {
    const stableJson = receiptJson(identity, verified.record)
    const publishedState: OperationState = {
      version: 1,
      operationId: identity.operationId,
      idempotencyKey: identity.idempotencyKey,
      inputFingerprint: identity.inputFingerprint,
      stage: "published",
      release: verified.record,
      receipt: null,
      receiptJson: stableJson,
      updatedAt: this.now(),
    }
    // This durable write occurs before the cross-system Notion write. If Notion
    // fails, an identical retry resumes only the receipt step.
    try {
      await this.options.ledger.putState(identity, publishedState)
    } catch (error) {
      return baseReceipt(identity, {
        status: "partial_failure",
        changed: releaseChanged,
        replay,
        published: true,
        records: [
          releaseRecord(
            verified.record,
            releaseChanged ? "published" : "observed"
          ),
        ],
        steps: [
          ...priorSteps,
          step("durable_publish_state", "failed", safeMessage(error)),
          step(
            "notion_receipt",
            "skipped",
            "Skipped until durable state is restored"
          ),
        ],
        retryable: true,
        resumeToken: `ghrel_resume_${sha256(`resume:${identity.idempotencyKey.replace("github-release:", "")}`).slice(0, 24)}`,
        repair:
          "Restore Redis and retry the identical input. GitHub will be read first; PATCH is issued only if the exact release is still a draft.",
      })
    }

    let written: { changed: boolean; pageId: string; url: string }
    try {
      written = await this.options.notion.writeReceipt(input, stableJson, {
        // Publication is already durable. A workflow may transition Approved to
        // Published/Done; receipt writeback still binds the immutable revision
        // and fingerprint but does not re-authorize an action that already ran.
        requireApproved: false,
      })
    } catch (error) {
      const packetError = error instanceof NotionPacketError ? error : null
      return baseReceipt(identity, {
        status: "partial_failure",
        changed: releaseChanged,
        replay,
        published: true,
        records: [
          releaseRecord(
            verified.record,
            releaseChanged ? "published" : "observed"
          ),
        ],
        steps: [
          ...priorSteps,
          step(
            "durable_publish_state",
            "completed",
            "Stored before Notion writeback"
          ),
          step("notion_receipt", "failed", safeMessage(error)),
        ],
        retryable: packetError?.kind === "unavailable",
        resumeToken: `ghrel_resume_${sha256(`resume:${identity.idempotencyKey.replace("github-release:", "")}`).slice(0, 24)}`,
        repair:
          "Retry the identical input. Durable state skips PATCH and resumes only Notion receipt writeback.",
      })
    }

    const completed = baseReceipt(identity, {
      status: releaseChanged || written.changed ? "completed" : "no_op",
      changed: releaseChanged || written.changed,
      replay,
      published: true,
      records: [
        releaseRecord(
          verified.record,
          releaseChanged ? "published" : "observed"
        ),
        notionRecord(written.pageId, written.url),
      ],
      steps: [
        ...priorSteps,
        step(
          "durable_publish_state",
          "completed",
          "Stored before Notion writeback"
        ),
        step(
          "notion_receipt",
          "completed",
          written.changed
            ? "Authoritative receipt written"
            : "Matching receipt already present"
        ),
      ],
      warnings: [
        "GitHub provides no conditional release PATCH; tag rules and immutable releases reduce but do not eliminate the final tag-move race.",
        ...(input.makeLatest === "true"
          ? []
          : [
              "GitHub release reads do not expose the original make_latest=false/legacy intent; publication is verified, but that intent is not claimed as independently observable.",
            ]),
      ],
    })
    try {
      await this.options.ledger.putState(identity, {
        ...publishedState,
        stage: "completed",
        receipt: completed,
        updatedAt: this.now(),
      })
    } catch (error) {
      return baseReceipt(identity, {
        status: "partial_failure",
        changed: releaseChanged || written.changed,
        replay,
        published: true,
        records: completed.records,
        steps: [
          ...completed.steps,
          step("operation_finalize", "failed", safeMessage(error)),
        ],
        warnings: completed.warnings,
        retryable: true,
        resumeToken: `ghrel_resume_${sha256(`resume:${identity.idempotencyKey.replace("github-release:", "")}`).slice(0, 24)}`,
        repair:
          "GitHub and Notion are complete. Restore Redis and retry the identical input to finalize only the durable operation state.",
      })
    }
    return completed
  }

  private failureReceipt(
    identity: LedgerIdentity,
    error: unknown,
    publicationAttempted: boolean
  ): PublishReceipt {
    if (error instanceof GitHubPublishedPostconditionError) {
      return baseReceipt(identity, {
        status: "partial_failure",
        changed: publicationAttempted,
        published: true,
        records: [
          releaseRecord(
            error.record,
            publicationAttempted ? "published" : "observed"
          ),
        ],
        steps: [
          step(
            "publish_release",
            "completed",
            "Exact release is observably published"
          ),
          step("postpublication_checkpoint", "failed", error.message),
          step(
            "notion_receipt",
            "skipped",
            "Skipped because the post-publication checkpoint was not verified"
          ),
        ],
        retryable: error.retryable,
        resumeToken: `ghrel_resume_${sha256(`resume:${identity.idempotencyKey.replace("github-release:", "")}`).slice(0, 24)}`,
        repair:
          "Inspect the exact published release and its post-publication policy, then retry the identical input. The published release is read before any possible PATCH.",
      })
    }
    if (error instanceof GitHubApiError && error.ambiguousMutation) {
      return baseReceipt(identity, {
        status: "ambiguous",
        steps: [step("publish_or_reconcile", "unknown", safeMessage(error))],
        retryable: true,
        resumeToken: `ghrel_resume_${sha256(`resume:${identity.idempotencyKey.replace("github-release:", "")}`).slice(0, 24)}`,
        repair:
          "Retry the identical input. The Worker will read the exact release ID before deciding whether PATCH is still needed.",
      })
    }
    if (publicationAttempted && error instanceof GitHubPreconditionError) {
      return baseReceipt(identity, {
        status: "ambiguous",
        steps: [
          step(
            "publish_reconciliation",
            "unknown",
            "Publication was attempted, but the exact release checkpoint could not be proven"
          ),
        ],
        retryable: true,
        resumeToken: `ghrel_resume_${sha256(`resume:${identity.idempotencyKey.replace("github-release:", "")}`).slice(0, 24)}`,
        repair:
          "Retry the identical input. The Worker will observe the exact release ID before any possible PATCH.",
      })
    }
    if (
      error instanceof PolicyError ||
      error instanceof GitHubPreconditionError ||
      (error instanceof NotionPacketError && error.kind === "conflict")
    ) {
      return baseReceipt(identity, {
        status: "conflict",
        steps: [step("precondition", "failed", safeMessage(error))],
        repair:
          "Correct the approval or provider state, create a new approved fingerprint, and retry.",
      })
    }
    const retryable =
      error instanceof LedgerError ||
      (error instanceof GitHubApiError && error.retryable) ||
      (error instanceof NotionPacketError && error.retryable)
    return baseReceipt(identity, {
      status: "blocked",
      steps: [step("execution", "failed", safeMessage(error))],
      retryable,
      repair: retryable
        ? "Resolve the unavailable dependency, then retry the identical input."
        : "Check credential permissions and the exact configured target before retrying.",
    })
  }
}

function safeMessage(error: unknown): string {
  if (
    error instanceof PolicyError ||
    error instanceof GitHubApiError ||
    error instanceof GitHubPreconditionError ||
    error instanceof GitHubPublishedPostconditionError ||
    error instanceof NotionPacketError ||
    error instanceof LedgerError
  ) {
    return error.message
  }
  return "Execution failed without exposing provider response content"
}
