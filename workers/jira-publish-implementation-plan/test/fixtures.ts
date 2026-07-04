import type { RuntimeConfig } from "../src/config.js"
import type { JiraIssueRef } from "../src/jira.js"
import type {
  InitialClaim,
  LeaseClaim,
  LeaseOwnership,
  OperationIdentity,
  OperationLedger,
} from "../src/ledger.js"
import type { JiraGateway, NotionGateway } from "../src/orchestrator.js"
import { NotionPlanError } from "../src/notion.js"
import {
  buildProviderPolicyFingerprint,
  canonicalPlan,
  sha256,
} from "../src/policy.js"
import type {
  OperationState,
  PlanNode,
  ProjectPolicy,
  PublishImplementationPlanInput,
} from "../src/types.js"

export const PAGE_ID = "11111111111111111111111111111111"

export const projectPolicy: ProjectPolicy = {
  projectKey: "ENG",
  projectId: "10000",
  issueTypeIds: new Set(["10001", "10002", "10003"]),
  parentTypePairs: new Set(["10001>10002", "10002>10003"]),
  assigneeAccountIds: new Set(["account-1"]),
  labels: new Set(["approved-plan"]),
  fixVersionIds: new Set(["20001"]),
  sprintIds: new Set([30001]),
  fieldIds: {
    estimate: "customfield_10016",
    sprint: "customfield_10020",
  },
}

export const config: RuntimeConfig = {
  cloudId: "00000000-0000-0000-0000-000000000000",
  siteUrl: "https://example.atlassian.net",
  email: "worker@example.com",
  apiToken: "fake-api-token-for-tests",
  projects: new Map([["ENG", projectPolicy]]),
  dependencyLinkTypeId: "10000",
  dependencyLinkTypeName: "Blocks",
  redisUrl: "https://example.upstash.io",
  redisToken: "fake-redis-token-for-tests",
  approvalStatusProperty: "Approval status",
  approvedStatus: "Approved",
  approvalRevisionProperty: "Approval revision",
  planHashProperty: "Approved plan hash",
  receiptProperty: "Jira publication receipt",
  jiraRequestTimeoutMs: 50,
  redisRequestTimeoutMs: 50,
  notionRequestTimeoutMs: 50,
  leaseTtlMs: 120_000,
}

export const providerPolicyFingerprint = buildProviderPolicyFingerprint({
  cloudId: config.cloudId,
  siteUrl: config.siteUrl,
  dependencyLinkTypeId: config.dependencyLinkTypeId,
  dependencyLinkTypeName: config.dependencyLinkTypeName,
  project: projectPolicy,
})

export function node(
  overrides: Partial<PlanNode> & Pick<PlanNode, "nodeKey" | "issueTypeId">
): PlanNode {
  return {
    nodeKey: overrides.nodeKey,
    issueTypeId: overrides.issueTypeId,
    parentNodeKey: overrides.parentNodeKey ?? null,
    summary: overrides.summary ?? `Implement ${overrides.nodeKey}`,
    description:
      overrides.description ?? `Approved work for ${overrides.nodeKey}`,
    assigneeAccountId:
      overrides.assigneeAccountId === undefined
        ? "account-1"
        : overrides.assigneeAccountId,
    labels: overrides.labels ?? ["approved-plan"],
    estimatePoints: overrides.estimatePoints ?? 3,
    sprintId: overrides.sprintId ?? 30001,
    fixVersionId: overrides.fixVersionId ?? "20001",
  }
}

export function inputFixture(
  overrides: Partial<PublishImplementationPlanInput> = {}
): PublishImplementationPlanInput {
  const base: PublishImplementationPlanInput = {
    approvalPageId: PAGE_ID,
    approvalRevision: "revision-7",
    planHash: "0".repeat(64),
    projectKey: "ENG",
    nodes: [
      node({ nodeKey: "epic", issueTypeId: "10001" }),
      node({
        nodeKey: "story",
        issueTypeId: "10002",
        parentNodeKey: "epic",
      }),
      node({
        nodeKey: "subtask",
        issueTypeId: "10003",
        parentNodeKey: "story",
      }),
    ],
    dependencies: [{ blockerNodeKey: "story", blockedNodeKey: "subtask" }],
  }
  const result = { ...base, ...overrides }
  result.planHash = overrides.planHash ?? sha256(canonicalPlan(result))
  return result
}

export class MemoryLedger implements OperationLedger {
  owner: string | null = null
  state: OperationState | null = null
  leaseAvailable = true
  leaseHeld = false
  leaseEpoch = 0
  leaseOwnership: LeaseOwnership | null = null
  putCount = 0
  releaseCount = 0
  rejectNextAcceptedNodeCheckpoint = false
  rejectNextAcceptedDependencyCheckpoint = false
  rejectNextCompletionCheckpoint = false
  rejectNextExistingNodeCheckpoint = false
  rejectNextDependencyStageCheckpoint = false
  rejectNextWritingReceiptCheckpoint = false

  async claimPublication(
    identity: OperationIdentity,
    state: OperationState
  ): Promise<InitialClaim> {
    if (this.owner && this.owner !== identity.idempotencyKey) return "conflict"
    if (this.owner) return "replay"
    this.owner = identity.idempotencyKey
    this.state = structuredClone(state)
    return "claimed"
  }

  async readState(): Promise<OperationState | null> {
    return this.state ? structuredClone(this.state) : null
  }

  async readPublicationOwner(): Promise<string | null> {
    return this.owner
  }

  async acquireLease(
    _identity: OperationIdentity,
    token: string
  ): Promise<LeaseClaim> {
    if (!this.leaseAvailable || this.leaseHeld) {
      return {
        acquired: false,
        retryAfterSeconds: 12,
        fencingEpoch: null,
      }
    }
    this.leaseHeld = true
    this.leaseEpoch += 1
    this.leaseOwnership = { token, fencingEpoch: this.leaseEpoch }
    return {
      acquired: true,
      retryAfterSeconds: null,
      fencingEpoch: this.leaseEpoch,
    }
  }

  async renewLease(
    _identity: OperationIdentity,
    lease: LeaseOwnership
  ): Promise<boolean> {
    return (
      this.leaseHeld &&
      JSON.stringify(lease) === JSON.stringify(this.leaseOwnership)
    )
  }

  async putState(
    identity: OperationIdentity,
    previous: OperationState,
    state: OperationState,
    lease: LeaseOwnership
  ): Promise<void> {
    if (
      this.owner !== identity.idempotencyKey ||
      !this.leaseHeld ||
      JSON.stringify(lease) !== JSON.stringify(this.leaseOwnership) ||
      JSON.stringify(previous) !== JSON.stringify(this.state)
    ) {
      throw new Error("memory ledger CAS rejected stale owner")
    }
    if (
      this.rejectNextAcceptedNodeCheckpoint &&
      previous.nodes.some(
        (node, index) =>
          node.requestDisposition === "fenced" &&
          state.nodes[index]?.requestDisposition === "accepted"
      )
    ) {
      this.rejectNextAcceptedNodeCheckpoint = false
      throw new Error("synthetic checkpoint loss")
    }
    if (
      this.rejectNextAcceptedDependencyCheckpoint &&
      previous.dependencies.some(
        (dependency, index) =>
          dependency.requestDisposition === "fenced" &&
          state.dependencies[index]?.requestDisposition === "accepted"
      )
    ) {
      this.rejectNextAcceptedDependencyCheckpoint = false
      throw new Error("synthetic dependency checkpoint loss")
    }
    if (
      this.rejectNextCompletionCheckpoint &&
      previous.stage === "writing_receipt" &&
      state.stage === "completed"
    ) {
      this.rejectNextCompletionCheckpoint = false
      throw new Error("synthetic completion checkpoint loss")
    }
    if (
      this.rejectNextExistingNodeCheckpoint &&
      previous.nodes.some(
        (node, index) =>
          !["created", "existing"].includes(node.status) &&
          state.nodes[index]?.status === "existing"
      )
    ) {
      this.rejectNextExistingNodeCheckpoint = false
      throw new Error("synthetic reconciliation checkpoint loss")
    }
    if (
      this.rejectNextDependencyStageCheckpoint &&
      previous.stage === "publishing_nodes" &&
      state.stage === "publishing_dependencies"
    ) {
      this.rejectNextDependencyStageCheckpoint = false
      throw new Error("synthetic dependency-stage checkpoint loss")
    }
    if (
      this.rejectNextWritingReceiptCheckpoint &&
      previous.stage === "publishing_dependencies" &&
      state.stage === "writing_receipt"
    ) {
      this.rejectNextWritingReceiptCheckpoint = false
      throw new Error("synthetic receipt checkpoint loss")
    }
    this.putCount += 1
    this.state = structuredClone(state)
  }

  async releaseLease(
    _identity: OperationIdentity,
    lease: LeaseOwnership
  ): Promise<void> {
    if (JSON.stringify(lease) !== JSON.stringify(this.leaseOwnership)) return
    this.releaseCount += 1
    this.leaseHeld = false
    this.leaseOwnership = null
  }
}

export class FakeNotion implements NotionGateway {
  verifyCount = 0
  writeCount = 0
  receipt = ""
  approved = true
  verifyError: Error | null = null
  writeError: Error | null = null

  async verify(
    input: PublishImplementationPlanInput,
    options: { requireApproved?: boolean; requireEmptyReceipt?: boolean } = {}
  ) {
    this.verifyCount += 1
    if (this.verifyError) throw this.verifyError
    if (options.requireApproved !== false && !this.approved) {
      throw new NotionPlanError("Notion approval is not currently approved", {
        kind: "conflict",
      })
    }
    if (options.requireEmptyReceipt && this.receipt !== "") {
      throw new NotionPlanError(
        "Notion Jira publication receipt must be empty before provider mutations",
        { kind: "conflict" }
      )
    }
    return {
      pageId: input.approvalPageId,
      url: `https://www.notion.so/${input.approvalPageId}`,
      receiptJson: this.receipt,
    }
  }

  async writeReceipt(
    input: PublishImplementationPlanInput,
    receiptJson: string
  ) {
    this.writeCount += 1
    if (this.writeError) throw this.writeError
    const changed = this.receipt !== receiptJson
    this.receipt = receiptJson
    return {
      changed,
      pageId: input.approvalPageId,
      url: `https://www.notion.so/${input.approvalPageId}`,
    }
  }
}

export class FakeJira implements JiraGateway {
  preflightCount = 0
  createNodeCount = 0
  createDependencyCount = 0
  findCount = 0
  preflightError: Error | null = null
  createNodeErrorAt: number | null = null
  ambiguousCreateAt: number | null = null
  ambiguousVisibilityLag = 0
  visibilityLag = new Map<string, number>()
  ambiguousLink = false
  issues = new Map<string, JiraIssueRef>()
  links = new Set<string>()

  async preflight(): Promise<void> {
    this.preflightCount += 1
    if (this.preflightError) throw this.preflightError
  }

  async findNode(args: { marker: string }): Promise<JiraIssueRef | null> {
    this.findCount += 1
    const lag = this.visibilityLag.get(args.marker) ?? 0
    if (lag > 0) {
      this.visibilityLag.set(args.marker, lag - 1)
      return null
    }
    return this.issues.get(args.marker) ?? null
  }

  async createNode(args: {
    marker: string
    node: PlanNode
  }): Promise<JiraIssueRef> {
    this.createNodeCount += 1
    if (this.createNodeErrorAt === this.createNodeCount) {
      const { JiraError } = await import("../src/jira.js")
      throw new JiraError("Jira rejected current state (HTTP 400)", {
        kind: "conflict",
        mutationDefinitelyRejected: true,
      })
    }
    const issue = {
      id: String(20000 + this.createNodeCount),
      key: `ENG-${this.createNodeCount}`,
      url: `https://example.atlassian.net/browse/ENG-${this.createNodeCount}`,
    }
    this.issues.set(args.marker, issue)
    if (this.ambiguousCreateAt === this.createNodeCount) {
      this.visibilityLag.set(args.marker, this.ambiguousVisibilityLag)
      const { JiraError } = await import("../src/jira.js")
      throw new JiraError("Jira mutation outcome is unknown", {
        kind: "ambiguous",
        retryable: true,
        mutationUnknown: true,
      })
    }
    return issue
  }

  async dependencyExists(
    blocker: JiraIssueRef,
    blocked: JiraIssueRef
  ): Promise<boolean> {
    return this.links.has(`${blocker.id}>${blocked.id}`)
  }

  async createDependency(
    blocker: JiraIssueRef,
    blocked: JiraIssueRef
  ): Promise<void> {
    this.createDependencyCount += 1
    this.links.add(`${blocker.id}>${blocked.id}`)
    if (this.ambiguousLink) {
      const { JiraError } = await import("../src/jira.js")
      throw new JiraError("Jira mutation outcome is unknown", {
        kind: "ambiguous",
        retryable: true,
        mutationUnknown: true,
      })
    }
  }
}
