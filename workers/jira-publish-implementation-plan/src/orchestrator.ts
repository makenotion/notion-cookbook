import { randomBytes } from "node:crypto"

import type { RuntimeConfig } from "./config.js"
import { type CreateNodeInput, JiraError, type JiraIssueRef } from "./jira.js"
import {
  LedgerError,
  type LeaseOwnership,
  type OperationIdentity,
  type OperationLedger,
} from "./ledger.js"
import { NotionPlanError } from "./notion.js"
import {
  assertReceipt,
  boundedRetryAfterSeconds,
  buildIdentity,
  buildProviderPolicyFingerprint,
  nodeMarker,
  normalizePageId,
  normalizeProjectKey,
  PolicyError,
  stableNodeOrder,
  validateInput,
} from "./policy.js"
import type {
  OperationState,
  PlanNode,
  ProjectPolicy,
  PublishImplementationPlanInput,
  PublishReceipt,
  ReceiptStatus,
} from "./types.js"

export interface JiraGateway {
  preflight(project: ProjectPolicy, nodes: PlanNode[]): Promise<void>
  findNode(input: CreateNodeInput): Promise<JiraIssueRef | null>
  createNode(input: CreateNodeInput): Promise<JiraIssueRef>
  dependencyExists(
    blocker: JiraIssueRef,
    blocked: JiraIssueRef
  ): Promise<boolean>
  createDependency(blocker: JiraIssueRef, blocked: JiraIssueRef): Promise<void>
}

export interface NotionGateway {
  verify(
    input: PublishImplementationPlanInput,
    options?: { requireApproved?: boolean; requireEmptyReceipt?: boolean }
  ): Promise<{ pageId: string; url: string; receiptJson: string }>
  writeReceipt(
    input: PublishImplementationPlanInput,
    receiptJson: string
  ): Promise<{ changed: boolean; pageId: string; url: string }>
}

type Clock = () => Date

export class PublishImplementationPlanOrchestrator {
  constructor(
    private readonly dependencies: {
      config: RuntimeConfig
      jira: JiraGateway
      ledger: OperationLedger
      notion: NotionGateway
      clock?: Clock
      leaseToken?: () => string
    }
  ) {}

  async execute(
    input: PublishImplementationPlanInput
  ): Promise<PublishReceipt> {
    let projectKey: string
    try {
      projectKey = normalizeProjectKey(input.projectKey)
    } catch (error) {
      return this.preIdentityFailure(
        input,
        "conflict",
        error instanceof Error ? error.message : "Project key is invalid"
      )
    }
    const project = this.dependencies.config.projects.get(projectKey)
    if (!project) {
      return this.preIdentityFailure(
        input,
        "conflict",
        "Project is not allowlisted"
      )
    }

    try {
      validateInput(input, project)
    } catch (error) {
      return this.preIdentityFailure(
        input,
        "conflict",
        error instanceof Error
          ? error.message
          : "Input policy validation failed"
      )
    }

    const providerPolicyFingerprint = buildProviderPolicyFingerprint({
      cloudId: this.dependencies.config.cloudId,
      siteUrl: this.dependencies.config.siteUrl,
      dependencyLinkTypeId: this.dependencies.config.dependencyLinkTypeId,
      dependencyLinkTypeName: this.dependencies.config.dependencyLinkTypeName,
      project,
    })
    const builtIdentity = buildIdentity(input, providerPolicyFingerprint)
    const identity: OperationIdentity = {
      idempotencyKey: builtIdentity.idempotencyKey,
      operationId: builtIdentity.operationId,
      publicationKey: builtIdentity.publicationKey,
      providerPolicyFingerprint,
    }
    const now = this.dependencies.clock ?? (() => new Date())
    const startedAt = now().toISOString()
    const initialState: OperationState = {
      version: 2,
      operationId: identity.operationId,
      idempotencyKey: identity.idempotencyKey,
      planHash: input.planHash,
      sourcePageId: normalizePageId(input.approvalPageId),
      approvalRevision: input.approvalRevision,
      projectKey,
      providerPolicyFingerprint,
      stage: "claimed",
      nodes: stableNodeOrder(input.nodes).map((node) => ({
        nodeKey: node.nodeKey,
        issueId: null,
        issueKey: null,
        url: null,
        marker: nodeMarker(identity.operationId, node.nodeKey),
        status: "pending",
        attempt: 0,
        requestDisposition: "not_sent",
      })),
      dependencies: [...input.dependencies]
        .sort((left, right) =>
          `${left.blockerNodeKey}>${left.blockedNodeKey}`.localeCompare(
            `${right.blockerNodeKey}>${right.blockedNodeKey}`
          )
        )
        .map((dependency) => ({
          ...dependency,
          status: "pending" as const,
          attempt: 0,
          requestDisposition: "not_sent" as const,
        })),
      receipt: null,
      receiptJson: null,
      startedAt,
      updatedAt: startedAt,
    }
    let latestState = initialState

    let approvalSnapshot: { pageId: string; url: string; receiptJson: string }
    try {
      const owner =
        await this.dependencies.ledger.readPublicationOwner(identity)
      if (owner !== null && owner !== identity.idempotencyKey) {
        return this.failure(input, identity, initialState, {
          status: "conflict",
          step: "claim",
          detail:
            "This Notion page already owns a different initial Jira publication; use the later reconcile tool for approved changes",
          retryable: false,
        })
      }
      const adopted =
        owner === identity.idempotencyKey
          ? await this.dependencies.ledger.readState(identity)
          : null
      if (owner !== null && !adopted) {
        throw new LedgerError("Claimed publication state disappeared")
      }
      if (adopted) {
        this.assertStateMatchesInput(adopted, input, providerPolicyFingerprint)
        latestState = adopted
      }
      const receiptOnly =
        adopted !== null &&
        ["writing_receipt", "completed"].includes(adopted.stage)
      approvalSnapshot = await this.dependencies.notion.verify(input, {
        requireApproved: !receiptOnly,
      })
      if (receiptOnly) {
        if (
          approvalSnapshot.receiptJson !== "" &&
          approvalSnapshot.receiptJson !== adopted.receiptJson
        ) {
          return this.failure(input, identity, adopted, {
            status: "conflict",
            step: "approval",
            detail:
              "Existing Notion receipt is not the exact fully bound canonical receipt for this durable operation",
            retryable: false,
            notionReceiptWritten: false,
          })
        }
      } else {
        if (approvalSnapshot.receiptJson !== "") {
          return this.failure(input, identity, adopted ?? initialState, {
            status: "conflict",
            step: "approval",
            detail:
              "Notion Jira publication receipt must be empty before provider mutations",
            retryable: false,
          })
        }
        // All fallible read-only provider validation happens before a page
        // can be permanently reserved by this initial publication.
        try {
          await this.dependencies.jira.preflight(project, input.nodes)
        } catch (error) {
          return this.failureFromError(
            input,
            identity,
            adopted ?? initialState,
            "metadata",
            error
          )
        }
        // A second exact read makes approval plus the empty receipt the final
        // authority check immediately before creating the permanent claim.
        approvalSnapshot = await this.dependencies.notion.verify(input, {
          requireApproved: true,
          requireEmptyReceipt: true,
        })
      }
    } catch (error) {
      return this.failureFromError(
        input,
        identity,
        latestState,
        "approval",
        error
      )
    }

    let claim: "claimed" | "replay" | "conflict"
    try {
      claim = await this.dependencies.ledger.claimPublication(
        identity,
        initialState
      )
    } catch (error) {
      return this.failure(input, identity, latestState, {
        status: "blocked",
        step: "claim",
        detail: this.safeError(
          error,
          "Durable publication claim is unavailable"
        ),
        retryable: true,
      })
    }
    if (claim === "conflict") {
      return this.failure(input, identity, latestState, {
        status: "conflict",
        step: "claim",
        detail:
          "This Notion page already owns a different initial Jira publication; use the later reconcile tool for approved changes",
        retryable: false,
      })
    }

    const leaseToken =
      this.dependencies.leaseToken?.() ?? randomBytes(24).toString("hex")
    let leaseOwnership: LeaseOwnership | null = null
    try {
      const lease = await this.dependencies.ledger.acquireLease(
        identity,
        leaseToken
      )
      if (!lease.acquired) {
        return this.failure(input, identity, latestState, {
          status: "blocked",
          step: "claim",
          detail: "The same plan publication is already running",
          retryable: true,
          retryAfterSeconds: lease.retryAfterSeconds,
        })
      }
      if (lease.fencingEpoch === null) {
        throw new LedgerError("Durable publication lease has no fencing epoch")
      }
      leaseOwnership = {
        token: leaseToken,
        fencingEpoch: lease.fencingEpoch,
      }

      let state = await this.dependencies.ledger.readState(identity)
      if (!state) {
        throw new LedgerError("Claimed publication state disappeared")
      }
      this.assertStateMatchesInput(state, input, providerPolicyFingerprint)
      latestState = state
      const activeLease = leaseOwnership
      const persistState = async (
        previous: OperationState,
        next: OperationState
      ): Promise<OperationState> => {
        await this.dependencies.ledger.putState(
          identity,
          previous,
          next,
          activeLease
        )
        latestState = next
        return next
      }
      if (state.stage === "completed") {
        if (!state.receipt || !state.receiptJson) {
          throw new LedgerError("Completed state has no canonical receipt")
        }
        if (approvalSnapshot.receiptJson === "") {
          try {
            await this.dependencies.notion.writeReceipt(
              input,
              state.receiptJson
            )
          } catch (error) {
            return this.failure(input, identity, state, {
              status: "partial_failure",
              step: "notion_receipt",
              detail: this.safeError(
                error,
                "Durable Jira publication is complete but its cleared Notion receipt could not be restored"
              ),
              retryable:
                error instanceof NotionPlanError ? error.retryable : true,
              notionReceiptWritten: false,
            })
          }
          return state.receipt
        }
        return this.replayReceipt(state)
      }
      if (state.stage === "writing_receipt") {
        if (!state.receipt || !state.receiptJson) {
          throw new LedgerError("Receipt checkpoint is incomplete")
        }
        const preparedReceipt = state.receipt
        try {
          await this.dependencies.notion.writeReceipt(input, state.receiptJson)
        } catch (error) {
          return this.failure(input, identity, state, {
            status: "partial_failure",
            step: "notion_receipt",
            detail: this.safeError(
              error,
              "Jira graph is complete but the canonical Notion receipt is not confirmed"
            ),
            retryable:
              error instanceof NotionPlanError ? error.retryable : true,
          })
        }
        const completedState: OperationState = {
          ...state,
          stage: "completed",
          updatedAt: now().toISOString(),
        }
        try {
          state = await persistState(state, completedState)
        } catch (error) {
          return this.failure(input, identity, state, {
            status: "partial_failure",
            step: "claim",
            detail: this.safeError(
              error,
              "Canonical Notion receipt is written but durable Redis completion is not confirmed"
            ),
            retryable: true,
            notionReceiptWritten: true,
          })
        }
        return preparedReceipt
      }

      try {
        await this.dependencies.notion.verify(input, {
          requireApproved: true,
          requireEmptyReceipt: true,
        })
      } catch (error) {
        return this.failureFromError(input, identity, state, "approval", error)
      }

      const inputByKey = new Map(
        input.nodes.map((node) => [node.nodeKey, node])
      )
      if (state.stage === "claimed") {
        state = await persistState(state, {
          ...state,
          stage: "publishing_nodes",
          updatedAt: now().toISOString(),
        })
      }

      for (let index = 0; index < state.nodes.length; index += 1) {
        let checkpoint = state.nodes[index]
        if (["created", "existing"].includes(checkpoint.status)) continue
        const node = inputByKey.get(checkpoint.nodeKey) as PlanNode
        const parent = this.parentRef(node, state)
        const nodeInput: CreateNodeInput = {
          operationId: identity.operationId,
          planHash: input.planHash,
          approvalPageId: input.approvalPageId,
          project,
          node,
          marker: checkpoint.marker,
          parent,
        }

        let observed: JiraIssueRef | null
        try {
          observed = await this.dependencies.jira.findNode(nodeInput)
        } catch (error) {
          return this.failureFromError(input, identity, state, "nodes", error)
        }
        if (observed) {
          state = await persistState(
            state,
            this.withNode(state, index, observed, "existing", now())
          )
          continue
        }
        if (
          checkpoint.requestDisposition === "fenced" ||
          checkpoint.requestDisposition === "outcome_unknown"
        ) {
          return this.failure(input, identity, state, {
            status: "ambiguous",
            step: "nodes",
            detail: `${checkpoint.nodeKey} has a non-expiring Jira request fence with no reconciled issue; the Worker will never blind-retry it`,
            retryable: true,
          })
        }

        const gate = await this.beforeMutation(input, identity, leaseOwnership)
        if (gate) {
          return this.failureFromError(
            input,
            identity,
            state,
            gate instanceof NotionPlanError ? "approval" : "claim",
            gate
          )
        }
        state = await persistState(
          state,
          this.withNodeRequestFence(state, index, now())
        )
        checkpoint = state.nodes[index]
        let created: JiraIssueRef
        try {
          created = await this.dependencies.jira.createNode(nodeInput)
        } catch (error) {
          const definitelyRejected =
            error instanceof JiraError && error.mutationDefinitelyRejected
          const outcome = definitelyRejected
            ? this.withNodeDefinitelyRejected(state, index, now())
            : this.withNodeUnknown(state, index, now())
          try {
            state = await persistState(state, outcome)
          } catch (ledgerError) {
            return this.failure(input, identity, state, {
              status: "ambiguous",
              step: "nodes",
              detail: `${checkpoint.nodeKey} request outcome could not be checkpointed: ${this.safeError(ledgerError, "ledger unavailable")}`,
              retryable: true,
            })
          }
          if (!definitelyRejected) {
            const unknownError =
              error instanceof JiraError && error.mutationUnknown
                ? error
                : new JiraError("Jira create outcome is unknown", {
                    kind: "ambiguous",
                    retryable: true,
                    mutationUnknown: true,
                  })
            return this.failureFromError(
              input,
              identity,
              state,
              "nodes",
              unknownError
            )
          }
          return this.failureFromError(input, identity, state, "nodes", error)
        }
        try {
          state = await persistState(
            state,
            this.withNode(state, index, created, "created", now())
          )
        } catch (error) {
          return this.failure(input, identity, state, {
            status: "ambiguous",
            step: "nodes",
            detail: this.safeError(
              error,
              `${checkpoint.nodeKey} may have been created but its fenced checkpoint could not advance`
            ),
            retryable: true,
          })
        }
      }

      if (state.stage !== "publishing_dependencies") {
        state = await persistState(state, {
          ...state,
          stage: "publishing_dependencies",
          updatedAt: now().toISOString(),
        })
      }
      for (let index = 0; index < state.dependencies.length; index += 1) {
        let checkpoint = state.dependencies[index]
        if (["created", "existing"].includes(checkpoint.status)) continue
        const blocker = this.requiredRef(state, checkpoint.blockerNodeKey)
        const blocked = this.requiredRef(state, checkpoint.blockedNodeKey)
        let exists: boolean
        try {
          exists = await this.dependencies.jira.dependencyExists(
            blocker,
            blocked
          )
        } catch (error) {
          return this.failureFromError(
            input,
            identity,
            state,
            "dependencies",
            error
          )
        }
        if (exists) {
          state = await persistState(
            state,
            this.withDependency(state, index, "existing", now())
          )
          continue
        }
        if (
          checkpoint.requestDisposition === "fenced" ||
          checkpoint.requestDisposition === "outcome_unknown"
        ) {
          return this.failure(input, identity, state, {
            status: "ambiguous",
            step: "dependencies",
            detail: `${checkpoint.blockerNodeKey}>${checkpoint.blockedNodeKey} has an unresolved Jira link outcome; no blind retry was attempted`,
            retryable: true,
          })
        }
        const gate = await this.beforeMutation(input, identity, leaseOwnership)
        if (gate) {
          return this.failureFromError(
            input,
            identity,
            state,
            gate instanceof NotionPlanError ? "approval" : "claim",
            gate
          )
        }
        state = await persistState(
          state,
          this.withDependencyRequestFence(state, index, now())
        )
        checkpoint = state.dependencies[index]
        try {
          await this.dependencies.jira.createDependency(blocker, blocked)
        } catch (error) {
          const definitelyRejected =
            error instanceof JiraError && error.mutationDefinitelyRejected
          try {
            state = await persistState(
              state,
              definitelyRejected
                ? this.withDependencyDefinitelyRejected(state, index, now())
                : this.withDependency(state, index, "unknown", now())
            )
          } catch (ledgerError) {
            return this.failure(input, identity, state, {
              status: "ambiguous",
              step: "dependencies",
              detail: this.safeError(
                ledgerError,
                "Dependency request outcome could not be checkpointed"
              ),
              retryable: true,
            })
          }
          if (
            !definitelyRejected &&
            (!(error instanceof JiraError) || !error.mutationUnknown)
          ) {
            error = new JiraError("Jira dependency outcome is unknown", {
              kind: "ambiguous",
              retryable: true,
              mutationUnknown: true,
            })
          }
          return this.failureFromError(
            input,
            identity,
            state,
            "dependencies",
            error
          )
        }
        try {
          if (
            !(await this.dependencies.jira.dependencyExists(blocker, blocked))
          ) {
            try {
              state = await persistState(
                state,
                this.withDependency(state, index, "unknown", now())
              )
            } catch (ledgerError) {
              return this.failure(input, identity, state, {
                status: "ambiguous",
                step: "dependencies",
                detail: this.safeError(
                  ledgerError,
                  "Dependency read-back and fenced checkpoint are unresolved"
                ),
                retryable: true,
              })
            }
            return this.failure(input, identity, state, {
              status: "ambiguous",
              step: "dependencies",
              detail:
                "Jira acknowledged a dependency but read-back did not confirm it",
              retryable: true,
            })
          }
        } catch (error) {
          try {
            state = await persistState(
              state,
              this.withDependency(state, index, "unknown", now())
            )
          } catch (ledgerError) {
            return this.failure(input, identity, state, {
              status: "ambiguous",
              step: "dependencies",
              detail: this.safeError(
                ledgerError,
                "Dependency read-back failure could not advance its fence"
              ),
              retryable: true,
            })
          }
          return this.failure(input, identity, state, {
            status: "ambiguous",
            step: "dependencies",
            detail: this.safeError(
              error,
              "Jira dependency was posted but exact read-back is unavailable"
            ),
            retryable: true,
          })
        }
        try {
          state = await persistState(
            state,
            this.withDependency(state, index, "created", now())
          )
        } catch (error) {
          return this.failure(input, identity, state, {
            status: "ambiguous",
            step: "dependencies",
            detail: this.safeError(
              error,
              "Jira dependency may exist but its fenced checkpoint could not advance"
            ),
            retryable: true,
          })
        }
      }

      let finalReceipt: PublishReceipt
      let receiptJson: string
      if (
        state.stage === "writing_receipt" &&
        state.receipt &&
        state.receiptJson
      ) {
        finalReceipt = state.receipt
        receiptJson = state.receiptJson
      } else {
        finalReceipt = this.completedReceipt(input, identity, state, now())
        receiptJson = JSON.stringify(finalReceipt)
        const writingState: OperationState = {
          ...state,
          stage: "writing_receipt",
          receipt: finalReceipt,
          receiptJson,
          updatedAt: now().toISOString(),
        }
        state = await persistState(state, writingState)
      }

      try {
        await this.dependencies.notion.writeReceipt(input, receiptJson)
      } catch (error) {
        return this.failure(input, identity, state, {
          status: "partial_failure",
          step: "notion_receipt",
          detail: this.safeError(
            error,
            "Jira graph is complete but the canonical Notion receipt is not confirmed"
          ),
          retryable: error instanceof NotionPlanError ? error.retryable : true,
        })
      }
      const completedState: OperationState = {
        ...state,
        stage: "completed",
        updatedAt: now().toISOString(),
      }
      try {
        state = await persistState(state, completedState)
      } catch (error) {
        return this.failure(input, identity, state, {
          status: "partial_failure",
          step: "claim",
          detail: this.safeError(
            error,
            "Notion receipt is written but final Redis completion is not confirmed"
          ),
          retryable: true,
          notionReceiptWritten: true,
        })
      }
      assertReceipt(finalReceipt)
      return finalReceipt
    } catch (error) {
      try {
        latestState =
          (await this.dependencies.ledger.readState(identity)) ?? latestState
      } catch {
        // Preserve the latest locally confirmed state if Redis is unavailable.
      }
      const status =
        error instanceof PolicyError
          ? "conflict"
          : this.hasUnresolvedFence(latestState)
            ? "ambiguous"
            : this.possibleProviderChange(latestState)
              ? "partial_failure"
              : "blocked"
      return this.failure(input, identity, latestState, {
        status,
        step: "claim",
        detail: this.safeError(
          error,
          "Publication orchestration failed safely"
        ),
        retryable: error instanceof LedgerError,
      })
    } finally {
      if (leaseOwnership) {
        await this.dependencies.ledger
          .releaseLease(identity, leaseOwnership)
          .catch(() => undefined)
      }
    }
  }

  private async beforeMutation(
    input: PublishImplementationPlanInput,
    identity: OperationIdentity,
    lease: LeaseOwnership
  ): Promise<unknown | null> {
    try {
      if (!(await this.dependencies.ledger.renewLease(identity, lease))) {
        throw new LedgerError("Durable publication lease was lost")
      }
      await this.dependencies.notion.verify(input, {
        requireApproved: true,
        requireEmptyReceipt: true,
      })
      return null
    } catch (error) {
      return error
    }
  }

  private parentRef(
    node: PlanNode,
    state: OperationState
  ): JiraIssueRef | null {
    return node.parentNodeKey === null
      ? null
      : this.requiredRef(state, node.parentNodeKey)
  }

  private requiredRef(state: OperationState, nodeKey: string): JiraIssueRef {
    const node = state.nodes.find((item) => item.nodeKey === nodeKey)
    if (!node?.issueId || !node.issueKey || !node.url) {
      throw new LedgerError(`${nodeKey} does not have a durable Jira identity`)
    }
    return { id: node.issueId, key: node.issueKey, url: node.url }
  }

  private withNode(
    state: OperationState,
    index: number,
    issue: JiraIssueRef,
    status: "created" | "existing",
    now: Date
  ): OperationState {
    const nodes = [...state.nodes]
    nodes[index] = {
      ...nodes[index],
      issueId: issue.id,
      issueKey: issue.key,
      url: issue.url,
      status,
      requestDisposition: "accepted",
    }
    return { ...state, nodes, updatedAt: now.toISOString() }
  }

  private withNodeUnknown(
    state: OperationState,
    index: number,
    now: Date
  ): OperationState {
    const nodes = [...state.nodes]
    nodes[index] = {
      ...nodes[index],
      status: "unknown",
      requestDisposition: "outcome_unknown",
    }
    return { ...state, nodes, updatedAt: now.toISOString() }
  }

  private withNodeRequestFence(
    state: OperationState,
    index: number,
    now: Date
  ): OperationState {
    const nodes = [...state.nodes]
    nodes[index] = {
      ...nodes[index],
      status: "pending",
      attempt: nodes[index].attempt + 1,
      requestDisposition: "fenced",
    }
    return { ...state, nodes, updatedAt: now.toISOString() }
  }

  private withNodeDefinitelyRejected(
    state: OperationState,
    index: number,
    now: Date
  ): OperationState {
    const nodes = [...state.nodes]
    nodes[index] = {
      ...nodes[index],
      status: "pending",
      requestDisposition: "definitely_rejected",
    }
    return { ...state, nodes, updatedAt: now.toISOString() }
  }

  private withDependency(
    state: OperationState,
    index: number,
    status: "unknown" | "created" | "existing",
    now: Date
  ): OperationState {
    const dependencies = [...state.dependencies]
    dependencies[index] = {
      ...dependencies[index],
      status,
      requestDisposition: status === "unknown" ? "outcome_unknown" : "accepted",
    }
    return { ...state, dependencies, updatedAt: now.toISOString() }
  }

  private withDependencyRequestFence(
    state: OperationState,
    index: number,
    now: Date
  ): OperationState {
    const dependencies = [...state.dependencies]
    dependencies[index] = {
      ...dependencies[index],
      status: "pending",
      attempt: dependencies[index].attempt + 1,
      requestDisposition: "fenced",
    }
    return { ...state, dependencies, updatedAt: now.toISOString() }
  }

  private withDependencyDefinitelyRejected(
    state: OperationState,
    index: number,
    now: Date
  ): OperationState {
    const dependencies = [...state.dependencies]
    dependencies[index] = {
      ...dependencies[index],
      status: "pending",
      requestDisposition: "definitely_rejected",
    }
    return { ...state, dependencies, updatedAt: now.toISOString() }
  }

  private completedReceipt(
    input: PublishImplementationPlanInput,
    identity: OperationIdentity,
    state: OperationState,
    now: Date
  ): PublishReceipt {
    const completedAt = now.toISOString()
    const receipt: PublishReceipt = {
      ok: true,
      status: "completed",
      operationId: identity.operationId,
      idempotencyKey: identity.idempotencyKey,
      changed: true,
      replay: false,
      projectKey: state.projectKey,
      planHash: state.planHash,
      approvalPageId: state.sourcePageId,
      approvalRevision: input.approvalRevision,
      providerPolicyFingerprint: state.providerPolicyFingerprint,
      startedAt: state.startedAt,
      completedAt,
      nodes: state.nodes.map((node) => ({
        nodeKey: node.nodeKey,
        issueId: node.issueId,
        issueKey: node.issueKey,
        url: node.url,
        action: node.status === "created" ? "created" : "existing",
      })),
      dependencies: state.dependencies.map((dependency) => ({
        blockerNodeKey: dependency.blockerNodeKey,
        blockedNodeKey: dependency.blockedNodeKey,
        action: dependency.status === "created" ? "created" : "existing",
      })),
      notionReceiptWritten: true,
      steps: [
        {
          name: "approval",
          status: "completed",
          detail: "Exact approval revision and canonical plan hash re-read",
        },
        {
          name: "claim",
          status: "completed",
          detail: "Atomic publication claim and durable per-step ledger held",
        },
        {
          name: "metadata",
          status: "completed",
          detail: "Current issue types, fields, users, and link type validated",
        },
        {
          name: "nodes",
          status: "completed",
          detail: `${state.nodes.length} hierarchy nodes resolved`,
        },
        {
          name: "dependencies",
          status: "completed",
          detail: `${state.dependencies.length} dependency links resolved`,
        },
        {
          name: "notion_receipt",
          status: "completed",
          detail: "Canonical graph receipt written to the approved Notion page",
        },
      ],
      warnings: [],
      retryable: false,
      retryAfterSeconds: null,
      repair: null,
    }
    assertReceipt(receipt)
    return receipt
  }

  private replayReceipt(state: OperationState): PublishReceipt {
    if (!state.receipt) throw new LedgerError("Completed state has no receipt")
    return {
      ...state.receipt,
      status: "no_op",
      changed: false,
      replay: true,
      nodes: state.receipt.nodes.map((node) => ({
        ...node,
        action: "existing",
      })),
      dependencies: state.receipt.dependencies.map((dependency) => ({
        ...dependency,
        action: "existing",
      })),
    }
  }

  private failureFromError(
    input: PublishImplementationPlanInput,
    identity: OperationIdentity,
    state: OperationState,
    step: PublishReceipt["steps"][number]["name"],
    error: unknown
  ): PublishReceipt {
    if (error instanceof JiraError) {
      const anyMutation = this.possibleProviderChange(state)
      const status: ReceiptStatus =
        error.mutationUnknown || this.hasUnresolvedFence(state)
          ? "ambiguous"
          : anyMutation
            ? "partial_failure"
            : error.kind === "conflict" || error.kind === "not_found"
              ? "conflict"
              : "blocked"
      return this.failure(input, identity, state, {
        status,
        step,
        detail: error.message,
        retryable: error.retryable,
        retryAfterSeconds: error.retryAfterSeconds,
      })
    }
    if (error instanceof NotionPlanError) {
      const changed = this.possibleProviderChange(state)
      return this.failure(input, identity, state, {
        status: changed
          ? "partial_failure"
          : error.kind === "conflict"
            ? "conflict"
            : "blocked",
        step,
        detail: error.message,
        retryable: error.retryable,
        repair:
          changed && error.kind === "conflict"
            ? "Restore the exact approved revision and plan hash without changing this input, then retry to reconcile only unfinished work."
            : undefined,
      })
    }
    const anyMutation = this.possibleProviderChange(state)
    return this.failure(input, identity, state, {
      status: anyMutation ? "partial_failure" : "blocked",
      step,
      detail: this.safeError(error, "A required system was unavailable"),
      retryable: error instanceof LedgerError,
    })
  }

  private failure(
    input: PublishImplementationPlanInput,
    identity: OperationIdentity,
    state: OperationState,
    options: {
      status: Exclude<ReceiptStatus, "completed" | "no_op">
      step: PublishReceipt["steps"][number]["name"]
      detail: string
      retryable: boolean
      retryAfterSeconds?: number | null
      notionReceiptWritten?: boolean
      repair?: string | null
    }
  ): PublishReceipt {
    const anyMutation = this.possibleProviderChange(state)
    const receipt: PublishReceipt = {
      ok: false,
      status: options.status,
      operationId: identity.operationId,
      idempotencyKey: identity.idempotencyKey,
      changed: anyMutation,
      replay: false,
      projectKey: normalizeProjectKey(input.projectKey),
      planHash: input.planHash,
      approvalPageId: normalizePageId(input.approvalPageId),
      approvalRevision: input.approvalRevision,
      providerPolicyFingerprint: state.providerPolicyFingerprint,
      startedAt: state.startedAt,
      completedAt: null,
      nodes: state.nodes.map((node) => ({
        nodeKey: node.nodeKey,
        issueId: node.issueId,
        issueKey: node.issueKey,
        url: node.url,
        action:
          node.status === "created"
            ? "created"
            : node.status === "existing"
              ? "existing"
              : node.status === "unknown" ||
                  ["fenced", "outcome_unknown"].includes(
                    node.requestDisposition
                  )
                ? "unknown"
                : "failed",
      })),
      dependencies: state.dependencies.map((dependency) => ({
        blockerNodeKey: dependency.blockerNodeKey,
        blockedNodeKey: dependency.blockedNodeKey,
        action:
          dependency.status === "created"
            ? "created"
            : dependency.status === "existing"
              ? "existing"
              : dependency.status === "unknown" ||
                  ["fenced", "outcome_unknown"].includes(
                    dependency.requestDisposition
                  )
                ? "unknown"
                : "failed",
      })),
      notionReceiptWritten:
        options.notionReceiptWritten ?? state.stage === "completed",
      steps: [
        {
          name: options.step,
          status: options.status === "ambiguous" ? "unknown" : "failed",
          detail: options.detail.slice(0, 300),
        },
      ],
      warnings: anyMutation
        ? [
            "Jira contains durable partial work; retry only with the same exact input",
          ]
        : [],
      retryable: options.retryable,
      retryAfterSeconds: boundedRetryAfterSeconds(options.retryAfterSeconds),
      repair:
        options.repair !== undefined
          ? options.repair
          : options.status === "ambiguous"
            ? "Retry the identical approved input. The Worker will reconcile its deterministic Jira marker before any further write."
            : anyMutation
              ? "Retry the identical approved input to resume only unfinished nodes, links, or receipt writeback."
              : null,
    }
    return receipt
  }

  private preIdentityFailure(
    input: PublishImplementationPlanInput,
    status: "conflict",
    detail: string
  ): PublishReceipt {
    let projectKey = "INVALID"
    let pageId = "00000000000000000000000000000000"
    try {
      projectKey = normalizeProjectKey(input.projectKey)
    } catch {
      // Return a bounded typed failure even before a valid identity exists.
    }
    try {
      pageId = normalizePageId(input.approvalPageId)
    } catch {
      // Return a bounded typed failure even before a valid identity exists.
    }
    return {
      ok: false,
      status,
      operationId: "jplan_invalid",
      idempotencyKey: "jira-plan:invalid",
      changed: false,
      replay: false,
      projectKey,
      planHash:
        typeof input.planHash === "string" &&
        /^[a-f0-9]{64}$/.test(input.planHash)
          ? input.planHash
          : "0".repeat(64),
      approvalPageId: pageId,
      approvalRevision:
        typeof input.approvalRevision === "string"
          ? input.approvalRevision.slice(0, 160)
          : "invalid",
      providerPolicyFingerprint: "0".repeat(64),
      startedAt: new Date(0).toISOString(),
      completedAt: null,
      nodes: [],
      dependencies: [],
      notionReceiptWritten: false,
      steps: [
        { name: "approval", status: "failed", detail: detail.slice(0, 300) },
      ],
      warnings: [],
      retryable: false,
      retryAfterSeconds: null,
      repair: null,
    }
  }

  private assertStateMatchesInput(
    state: OperationState,
    input: PublishImplementationPlanInput,
    providerPolicyFingerprint: string
  ): void {
    if (
      state.planHash !== input.planHash ||
      state.sourcePageId !== normalizePageId(input.approvalPageId) ||
      state.approvalRevision !== input.approvalRevision ||
      state.projectKey !== normalizeProjectKey(input.projectKey) ||
      state.providerPolicyFingerprint !== providerPolicyFingerprint
    ) {
      throw new LedgerError("Durable state does not match the approved input")
    }

    const expectedNodes = stableNodeOrder(input.nodes)
    const expectedDependencies = [...input.dependencies].sort((left, right) =>
      `${left.blockerNodeKey}>${left.blockedNodeKey}`.localeCompare(
        `${right.blockerNodeKey}>${right.blockedNodeKey}`
      )
    )
    if (
      state.nodes.length !== expectedNodes.length ||
      state.dependencies.length !== expectedDependencies.length ||
      state.nodes.some(
        (node, index) =>
          node.nodeKey !== expectedNodes[index]?.nodeKey ||
          node.marker !== nodeMarker(state.operationId, node.nodeKey)
      ) ||
      state.dependencies.some(
        (dependency, index) =>
          dependency.blockerNodeKey !==
            expectedDependencies[index]?.blockerNodeKey ||
          dependency.blockedNodeKey !==
            expectedDependencies[index]?.blockedNodeKey
      )
    ) {
      throw new LedgerError(
        "Durable state topology does not match the approved input"
      )
    }
  }

  private possibleProviderChange(state: OperationState): boolean {
    if (state.receipt?.changed) return true
    const possible = (checkpoint: {
      status: string
      attempt: number
      requestDisposition: string
    }): boolean =>
      checkpoint.status === "created" ||
      (checkpoint.attempt > 0 &&
        ["fenced", "outcome_unknown", "accepted"].includes(
          checkpoint.requestDisposition
        ))
    return state.nodes.some(possible) || state.dependencies.some(possible)
  }

  private hasUnresolvedFence(state: OperationState): boolean {
    const unresolved = (checkpoint: { requestDisposition: string }): boolean =>
      ["fenced", "outcome_unknown"].includes(checkpoint.requestDisposition)
    return state.nodes.some(unresolved) || state.dependencies.some(unresolved)
  }

  private safeError(error: unknown, fallback: string): string {
    if (
      error instanceof JiraError ||
      error instanceof LedgerError ||
      error instanceof NotionPlanError ||
      error instanceof PolicyError
    ) {
      return error.message
    }
    return fallback
  }
}
