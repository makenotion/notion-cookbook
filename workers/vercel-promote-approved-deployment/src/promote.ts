import {
  canonicalPromotionIncidentJson,
  matchingStoredReceipt,
  operationIdentity,
  promotionIncidentReceiptHash,
  retrieveApproval,
  verifyApproval,
  writePromotionIncidentReceipt,
  writePromotionReceipt,
} from "./approval.js"
import {
  DEPLOYMENT_HOSTNAME,
  DEPLOYMENT_ID,
  findTargetPolicy,
  PROJECT_ID,
  TEAM_ID,
  validatePromoteInput,
} from "./config.js"
import type {
  OperationRecord,
  HealthFailureEvidence,
  PromoteInput,
  PromotionObservation,
  PromotionResult,
  ResultStatus,
  RuntimeDependencies,
  TargetPolicy,
  WorkerConfig,
} from "./types.js"
import {
  HealthCheckFailure,
  isDefinitePromotionRejectionStatus,
  SafetyError,
  VercelHttpError,
} from "./types.js"
import {
  MAX_PROJECT_ALIAS_INVENTORY,
  observePromotion,
  ProjectAliasSetMismatchError,
  verifyDeploymentChecks,
  verifyPromotedDeploymentIdentity,
  verifyRollbackTarget,
  verifyStagedDeployment,
} from "./vercel.js"

interface LeaseIdentity {
  key: string
  token: string
}

function iso(dependencies: RuntimeDependencies): string {
  return dependencies.now().toISOString()
}

function resultFor(options: {
  operationId: string
  status: ResultStatus
  input: PromoteInput
  policy: TargetPolicy
  startedAt: string
  completedAt?: string | null
  promotionRequested: boolean
  receiptWritten: boolean
  currentDeploymentId?: string | null
  productionDomains?: string[]
  domainDeploymentIds?: Record<string, string | null>
  deploymentUrl?: string | null
  message: string
  retryable?: boolean
  retryAfterMs?: number | null
  repairInstruction?: string | null
  preconditionsVerified?: boolean
  changed?: boolean
  healthFailure?: HealthFailureEvidence | null
  incidentReceiptHash?: string | null
  freshApprovalInstruction?: string | null
  rollbackTargetGitSha?: string | null
  rollbackTargetGitBranch?: string | null
}): PromotionResult {
  const { input, policy } = options
  const productionDomains =
    options.productionDomains ?? policy.productionDomains
  const aliasState = productionDomains.map((domain) => ({
    domain,
    deploymentId: options.domainDeploymentIds
      ? (options.domainDeploymentIds[domain] ?? null)
      : (options.currentDeploymentId ?? null),
  }))
  if (
    (options.deploymentUrl !== undefined &&
      options.deploymentUrl !== null &&
      !DEPLOYMENT_HOSTNAME.test(options.deploymentUrl)) ||
    (options.currentDeploymentId !== undefined &&
      options.currentDeploymentId !== null &&
      !DEPLOYMENT_ID.test(options.currentDeploymentId)) ||
    (options.domainDeploymentIds !== undefined &&
      Object.values(options.domainDeploymentIds).some(
        (deploymentId) =>
          deploymentId !== null && !DEPLOYMENT_ID.test(deploymentId)
      ))
  ) {
    throw new SafetyError(
      "RECEIPT_SEMANTICS",
      "Provider-derived deployment evidence is invalid or unbounded."
    )
  }
  const preconditionsVerified =
    options.preconditionsVerified ?? options.status !== "blocked"
  const ok = options.status === "completed" || options.status === "no_op"
  const replay = options.status === "no_op"
  const changed =
    options.changed ??
    (options.status === "completed"
      ? options.promotionRequested
      : (options.status === "partial_failure" ||
          options.status === "rollback_recommended") &&
        (options.completedAt != null ||
          options.currentDeploymentId === input.deploymentId))
  const retryable =
    options.retryable ??
    (options.status === "ambiguous" || options.status === "partial_failure")
  const repairInstruction = ok
    ? null
    : (options.repairInstruction ??
      (retryable
        ? "Call the tool again with the exact same approved inputs; it will reconcile before any mutation."
        : "Resolve the reported conflict or policy failure, create a new approval revision if needed, and then call the tool again."))
  const records = [
    {
      kind: "approval" as const,
      system: "notion" as const,
      id: input.approvalPageId,
      url: `https://www.notion.so/${input.approvalPageId.replaceAll("-", "")}`,
      action: !preconditionsVerified
        ? ("observed" as const)
        : options.receiptWritten
          ? ("receipt_written" as const)
          : ("verified" as const),
      state: preconditionsVerified ? "verified" : "unverified",
    },
    {
      kind: "project" as const,
      system: "vercel" as const,
      id: input.projectId,
      url: `https://api.vercel.com/v9/projects/${encodeURIComponent(input.projectId)}?teamId=${encodeURIComponent(input.teamId)}`,
      action: !preconditionsVerified
        ? ("observed" as const)
        : ("verified" as const),
      state: options.currentDeploymentId
        ? `current:${options.currentDeploymentId}`
        : "current:unknown",
    },
    {
      kind: "deployment" as const,
      system: "vercel" as const,
      id: input.deploymentId,
      url: options.deploymentUrl ? `https://${options.deploymentUrl}` : null,
      action:
        options.status === "completed" && options.promotionRequested
          ? ("promoted" as const)
          : ("observed" as const),
      state: options.status,
    },
    ...productionDomains.map((domain) => {
      const routedDeploymentId = options.domainDeploymentIds
        ? (options.domainDeploymentIds[domain] ?? null)
        : (options.currentDeploymentId ?? null)
      return {
        kind: "production_domain" as const,
        system: "vercel" as const,
        id: domain,
        url: `https://${domain}`,
        action:
          routedDeploymentId === input.deploymentId
            ? ("routed" as const)
            : ("observed" as const),
        state:
          routedDeploymentId === input.deploymentId
            ? "target"
            : routedDeploymentId === input.expectedCurrentDeploymentId
              ? "previous"
              : "unknown",
      }
    }),
  ]
  const promotionStep = options.promotionRequested
    ? options.status === "ambiguous"
      ? ("pending" as const)
      : ("completed" as const)
    : ("skipped" as const)
  const steps: PromotionResult["steps"] = ok
    ? [
        { name: "approval", state: "completed" },
        { name: "preflight", state: "completed" },
        { name: "promotion", state: replay ? "skipped" : promotionStep },
        { name: "reconciliation", state: "completed" },
        { name: "receipt", state: "completed" },
      ]
    : options.status === "blocked" && !preconditionsVerified
      ? [
          { name: "approval", state: "blocked" },
          { name: "preflight", state: "blocked" },
          {
            name: "promotion",
            state: options.promotionRequested ? "blocked" : "skipped",
          },
          { name: "reconciliation", state: "skipped" },
          { name: "receipt", state: "skipped" },
        ]
      : options.status === "blocked"
        ? [
            { name: "approval", state: "completed" },
            { name: "preflight", state: "completed" },
            {
              name: "promotion",
              state: options.promotionRequested ? "blocked" : "skipped",
            },
            { name: "reconciliation", state: "skipped" },
            { name: "receipt", state: "skipped" },
          ]
        : [
            { name: "approval", state: "completed" },
            { name: "preflight", state: "completed" },
            { name: "promotion", state: promotionStep },
            {
              name: "reconciliation",
              state: options.status === "ambiguous" ? "pending" : "failed",
            },
            {
              name: "receipt",
              state:
                options.status === "partial_failure" && options.completedAt
                  ? "failed"
                  : "skipped",
            },
          ]
  const warnings =
    options.status === "ambiguous"
      ? ["Promotion outcome is unknown; never issue an unobserved retry."]
      : options.status === "rollback_recommended"
        ? [
            "Post-promotion health failed; rollback requires a separate fresh Notion approval and a separate tool call.",
            "Vercel exposes no compare-and-swap guard; state is revalidated immediately before rollback but a residual external race remains.",
          ]
        : options.status === "partial_failure"
          ? [
              "Some terminal work remains; retain the resume token as correlation evidence.",
            ]
          : options.status === "conflict"
            ? [
                "Live production state conflicts with this operation's expected state.",
              ]
            : []
  const result: PromotionResult = {
    ok,
    operationId: options.operationId,
    idempotencyKey: options.operationId,
    status: options.status,
    changed,
    replay,
    preconditionsVerified,
    promotionRequested: options.promotionRequested,
    receiptWritten: options.receiptWritten,
    records,
    steps,
    warnings,
    retryable,
    retryAfterMs: options.retryAfterMs ?? null,
    resumeToken: retryable ? options.operationId : null,
    repairInstruction,
    teamId: input.teamId,
    projectId: input.projectId,
    deploymentId: input.deploymentId,
    deploymentUrl: options.deploymentUrl ?? null,
    previousDeploymentId: input.expectedCurrentDeploymentId,
    currentDeploymentId: options.currentDeploymentId ?? null,
    gitSha: input.expectedGitSha,
    gitBranch: input.expectedGitBranch,
    approvalPageId: input.approvalPageId,
    approvalRevision: input.approvalRevision,
    approvalFingerprint: input.approvalFingerprint,
    checkIds: policy.deploymentChecks.map((check) => check.id),
    checkNames: policy.deploymentChecks.map((check) => check.name ?? check.id),
    healthPaths: [...policy.healthPaths],
    productionDomains: [...productionDomains],
    aliasState,
    healthFailure: options.healthFailure ?? null,
    rollbackRequested: false,
    incidentReceiptHash: options.incidentReceiptHash ?? null,
    freshApprovalInstruction: options.freshApprovalInstruction ?? null,
    rollbackTargetGitSha: options.rollbackTargetGitSha ?? null,
    rollbackTargetGitBranch: options.rollbackTargetGitBranch ?? null,
    residualRaceWarning:
      "Vercel exposes no provider compare-and-swap precondition; the project lease coordinates this Worker only, so dashboard, CLI, and other API writers can still race after the final read.",
    startedAt: options.startedAt,
    completedAt: options.completedAt ?? null,
    message: options.message,
  }
  if (
    result.status === "rollback_recommended" &&
    result.incidentReceiptHash === null
  ) {
    result.incidentReceiptHash = promotionIncidentReceiptHash(result)
  }
  assertPromotionResultSemantics(result)
  return result
}

export function assertPromotionResultSemantics(result: PromotionResult): void {
  const success = result.status === "completed" || result.status === "no_op"
  if (
    result.ok !== success ||
    result.idempotencyKey !== result.operationId ||
    result.replay !== (result.status === "no_op") ||
    (result.status === "blocked" &&
      result.promotionRequested &&
      !result.preconditionsVerified) ||
    (result.ok && result.repairInstruction !== null) ||
    (!result.ok && result.repairInstruction === null) ||
    result.retryable !== (result.resumeToken !== null) ||
    result.steps.length !== 5 ||
    result.records.length < 3 ||
    (result.receiptWritten
      ? result.records[0]?.action !== "receipt_written"
      : result.records[0]?.action === "receipt_written")
  ) {
    throw new SafetyError(
      "RECEIPT_SEMANTICS",
      "The public receipt fields are internally inconsistent."
    )
  }
  if (
    result.rollbackRequested ||
    (result.status === "rollback_recommended" &&
      (!result.healthFailure ||
        !result.incidentReceiptHash ||
        result.retryable ||
        !result.changed ||
        result.currentDeploymentId !== result.deploymentId ||
        result.freshApprovalInstruction === null ||
        result.rollbackTargetGitSha === null ||
        result.rollbackTargetGitBranch === null)) ||
    (result.status !== "rollback_recommended" &&
      (result.healthFailure !== null ||
        result.incidentReceiptHash !== null ||
        result.freshApprovalInstruction !== null ||
        result.rollbackTargetGitSha !== null ||
        result.rollbackTargetGitBranch !== null))
  ) {
    throw new SafetyError(
      "RECEIPT_SEMANTICS",
      "The rollback recommendation fields are internally inconsistent."
    )
  }
}

function newRecord(
  operationId: string,
  input: PromoteInput,
  policy: TargetPolicy,
  createdAt: string
): OperationRecord {
  return {
    version: 1,
    operationId,
    state: "prepared",
    input: { ...input },
    policy: {
      ...policy,
      productionDomains: [...policy.productionDomains],
      deploymentChecks: policy.deploymentChecks.map((check) => ({ ...check })),
      healthPaths: [...policy.healthPaths],
    },
    createdAt,
    updatedAt: createdAt,
    mutationStartedAt: null,
    promotionAcceptedAt: null,
    mutationAttempts: 0,
    lastMutationStatus: null,
    lastIssue: null,
    result: null,
  }
}

function assertRecordIdentity(
  record: OperationRecord,
  input: PromoteInput,
  policy: TargetPolicy
): void {
  if (
    JSON.stringify(record.input) !== JSON.stringify(input) ||
    JSON.stringify(record.policy) !== JSON.stringify(policy)
  ) {
    throw new SafetyError(
      "COORDINATION_CORRUPT",
      "The durable operation record does not match this exact approved request."
    )
  }
}

async function saveRecord(
  record: OperationRecord,
  config: WorkerConfig,
  dependencies: RuntimeDependencies,
  lease: LeaseIdentity
): Promise<void> {
  await ensureLease(lease.key, lease.token, config, dependencies)
  record.updatedAt = iso(dependencies)
  const crossedMutationBoundary =
    record.state === "mutation_started" ||
    record.state === "mutation_unknown" ||
    record.state === "receipt_pending" ||
    record.state === "complete"
  await dependencies.store.putOperation(
    record,
    crossedMutationBoundary ? null : config.operationTtlSeconds
  )
  await ensureLease(lease.key, lease.token, config, dependencies)
}

async function ensureLease(
  leaseKey: string,
  leaseToken: string,
  config: WorkerConfig,
  dependencies: RuntimeDependencies
): Promise<void> {
  const renewed = await dependencies.store.renewLease(
    leaseKey,
    leaseToken,
    config.leaseTtlMs
  )
  if (!renewed) {
    throw new SafetyError(
      "LEASE_LOST",
      "The project-wide promotion lease expired or changed owner."
    )
  }
}

function assertLeaseBudget(config: WorkerConfig): void {
  // A preflight can consume one three-attempt Vercel read budget followed by
  // all five sequential health paths before the next renewal. The additional
  // retry allowance covers the two bounded 5-second read backoffs.
  const longestUninterruptedStepMs =
    3 * config.requestTimeoutMs + 10_000 + 5 * config.healthTimeoutMs
  if (config.leaseTtlMs <= longestUninterruptedStepMs) {
    throw new SafetyError(
      "CONFIGURATION",
      `VERCEL_PROMOTION_LEASE_TTL_MS must exceed ${longestUninterruptedStepMs} ms for the configured request budgets.`
    )
  }
}

async function verifyPreconditions(
  input: PromoteInput,
  policy: TargetPolicy,
  config: WorkerConfig,
  dependencies: RuntimeDependencies
): Promise<string> {
  const [approval, project, deployment, definitions, runs] = await Promise.all([
    retrieveApproval(
      dependencies.notion,
      input.approvalPageId,
      config.receiptProperty
    ),
    dependencies.vercel.getProject(input.teamId, input.projectId),
    dependencies.vercel.getDeployment(input.teamId, input.deploymentId),
    dependencies.vercel.getCheckDefinitions(input.teamId, input.projectId),
    dependencies.vercel.getCheckRuns(input.teamId, input.deploymentId),
  ])
  verifyApproval(approval, input, { requireRevision: true })
  if (approval.receiptText !== "") {
    throw new SafetyError(
      "APPROVAL_RECEIPT_NOT_EMPTY",
      "A fresh promotion requires the configured Notion receipt property to be empty."
    )
  }
  verifyStagedDeployment({
    project,
    deployment,
    policy,
    teamId: input.teamId,
    projectId: input.projectId,
    deploymentId: input.deploymentId,
    expectedGitSha: input.expectedGitSha,
    expectedGitBranch: input.expectedGitBranch,
    expectedCurrentDeploymentId: input.expectedCurrentDeploymentId,
  })
  verifyDeploymentChecks({
    definitions,
    runs,
    policy,
    deployment,
    projectId: input.projectId,
    now: dependencies.now(),
    maxAgeMs: config.checkMaxAgeMs,
  })
  await dependencies.vercel.checkHealth(deployment.url!, policy.healthPaths)
  return deployment.url!
}

function convergenceStatus(
  observation: PromotionObservation
): Exclude<ResultStatus, "completed" | "no_op" | "blocked"> {
  if (observation.classification === "other_current") return "conflict"
  if (
    observation.classification === "partial" ||
    observation.classification === "target_current"
  )
    return "partial_failure"
  return "ambiguous"
}

async function persistUnresolved(
  record: OperationRecord,
  observation: PromotionObservation | null,
  lease: LeaseIdentity,
  config: WorkerConfig,
  dependencies: RuntimeDependencies,
  issue: string,
  receiptWrittenOverride?: boolean
): Promise<PromotionResult> {
  const status = observation ? convergenceStatus(observation) : "ambiguous"
  const currentDeploymentId = observation?.currentDeploymentId ?? null
  const receiptWritten =
    receiptWrittenOverride ?? record.result?.receiptWritten === true
  const message =
    status === "conflict"
      ? "Another deployment owns the exact complete production-domain set; no retry was attempted."
      : issue === "PROJECT_ALIAS_INVENTORY_TOO_LARGE"
        ? `Vercel returned more than the supported ${MAX_PROJECT_ALIAS_INVENTORY} project aliases, so production state cannot be classified; no retry was attempted.`
        : status === "partial_failure" &&
            observation?.classification === "target_current"
          ? "Production routes to the approved deployment, but final verification is incomplete; no second promotion was attempted."
          : status === "partial_failure"
            ? "Production aliases are split or incomplete; no retry was attempted."
            : "The promotion outcome is not yet authoritative; call the same operation again to reconcile without reissuing POST."
  record.state = "mutation_unknown"
  record.lastIssue = issue
  record.result = resultFor({
    operationId: record.operationId,
    status,
    input: record.input,
    policy: record.policy,
    startedAt: record.createdAt,
    promotionRequested: record.mutationAttempts > 0,
    receiptWritten,
    currentDeploymentId,
    productionDomains: observation?.productionDomains,
    domainDeploymentIds: observation?.domainDeploymentIds,
    deploymentUrl: observation?.deployment.url ?? null,
    message,
    repairInstruction:
      observation?.classification === "target_current"
        ? "Do not promote again. Investigate the final health or provider-verification failure, then resume this exact operation for read-only reconciliation and receipt writeback."
        : undefined,
  })
  try {
    await saveRecord(record, config, dependencies, lease)
    return record.result
  } catch (error) {
    if (!receiptWritten) throw error
    const code =
      error instanceof SafetyError ? error.code : "COORDINATION_UNAVAILABLE"
    return {
      ...record.result,
      repairInstruction:
        record.result.status === "conflict"
          ? "Do not resume or reuse this approval. Restore Redis coordination separately, investigate the live conflict, and require a new approval for any new promotion."
          : "Do not promote again. The canonical Notion receipt is confirmed; restore Redis coordination, investigate provider state, and resume this exact operation read-only.",
      message: `${record.result.message} The receipt remains confirmed, but durable reconciliation state could not be saved (${code}).`,
    }
  }
}

async function persistPostTargetIncident(
  record: OperationRecord,
  observation: PromotionObservation,
  lease: LeaseIdentity,
  config: WorkerConfig,
  dependencies: RuntimeDependencies,
  issue: string,
  receiptWritten = false,
  message = "Production reached the approved deployment, but the final provider observation changed before receipt writeback."
): Promise<PromotionResult> {
  record.state = "mutation_unknown"
  record.lastIssue = issue
  record.result = resultFor({
    operationId: record.operationId,
    status: "partial_failure",
    input: record.input,
    policy: record.policy,
    startedAt: record.createdAt,
    promotionRequested: record.mutationAttempts > 0,
    receiptWritten,
    currentDeploymentId: observation.currentDeploymentId,
    productionDomains: observation.productionDomains,
    domainDeploymentIds: observation.domainDeploymentIds,
    deploymentUrl: observation.deployment.url ?? null,
    changed: true,
    repairInstruction:
      "Do not promote again. Production previously reached the approved deployment; investigate the provider drift, then resume this exact operation for read-only reconciliation.",
    message,
  })
  try {
    await saveRecord(record, config, dependencies, lease)
    return record.result
  } catch (error) {
    if (!receiptWritten) throw error
    const code =
      error instanceof SafetyError ? error.code : "COORDINATION_UNAVAILABLE"
    return {
      ...record.result,
      repairInstruction:
        "Do not promote again. The canonical Notion receipt is confirmed; restore Redis coordination, investigate provider drift, and resume this exact operation read-only.",
      message: `${record.result.message} The receipt remains confirmed, but durable drift state could not be saved (${code}).`,
    }
  }
}

async function persistRollbackRecommendation(
  record: OperationRecord,
  observation: PromotionObservation,
  healthFailure: HealthFailureEvidence,
  lease: LeaseIdentity,
  config: WorkerConfig,
  dependencies: RuntimeDependencies
): Promise<PromotionResult> {
  await ensureLease(lease.key, lease.token, config, dependencies)
  const rollbackTarget = await dependencies.vercel.getDeployment(
    record.input.teamId,
    record.input.expectedCurrentDeploymentId
  )
  await ensureLease(lease.key, lease.token, config, dependencies)
  const rollbackGitSha = rollbackTarget.gitSource?.sha
  const rollbackGitBranch = rollbackTarget.gitSource?.ref
  if (!rollbackGitSha || !rollbackGitBranch) {
    throw new SafetyError(
      "ROLLBACK_TARGET_GIT_MISSING",
      "The exact prior deployment has no bounded Git identity for a fresh rollback approval."
    )
  }
  verifyRollbackTarget({
    project: observation.project,
    deployment: rollbackTarget,
    teamId: record.input.teamId,
    projectId: record.input.projectId,
    deploymentId: record.input.expectedCurrentDeploymentId,
    expectedGitSha: rollbackGitSha,
    expectedGitBranch: rollbackGitBranch,
  })
  const observedAt = iso(dependencies)
  let recommendation = resultFor({
    operationId: record.operationId,
    status: "rollback_recommended",
    input: record.input,
    policy: record.policy,
    startedAt: record.createdAt,
    completedAt: observedAt,
    promotionRequested: record.mutationAttempts > 0,
    receiptWritten: false,
    currentDeploymentId: record.input.deploymentId,
    productionDomains: observation.productionDomains,
    domainDeploymentIds: observation.domainDeploymentIds,
    deploymentUrl: observation.deployment.url ?? null,
    changed: true,
    retryable: false,
    healthFailure,
    rollbackTargetGitSha: rollbackGitSha,
    rollbackTargetGitBranch: rollbackGitBranch,
    freshApprovalInstruction:
      "Create a new Notion rollback approval that binds this promotion incident page and hash, the exact candidate and prior deployment, and the incident-recorded rollback Git identity; then explicitly confirm rollbackApprovedDeployment.",
    repairInstruction:
      "Do not promote or roll back automatically. Obtain the separately fingerprinted fresh Notion rollback approval described in freshApprovalInstruction.",
    message:
      "Production is unanimously on the approved candidate, but a fixed post-promotion health check failed. A separate fresh rollback approval is required; no rollback was requested.",
  })
  record.state = "mutation_unknown"
  record.lastIssue = "POST_PROMOTION_HEALTH_FAILED"
  record.result = recommendation
  await saveRecord(record, config, dependencies, lease)

  try {
    await writePromotionIncidentReceipt(
      dependencies.notion,
      record.input,
      config.incidentProperty ?? "Promotion incident",
      recommendation
    )
  } catch (error) {
    const code =
      error instanceof SafetyError ? error.code : "INCIDENT_WRITE_FAILED"
    const pending = resultFor({
      operationId: record.operationId,
      status: "partial_failure",
      input: record.input,
      policy: record.policy,
      startedAt: record.createdAt,
      completedAt: observedAt,
      promotionRequested: record.mutationAttempts > 0,
      receiptWritten: false,
      currentDeploymentId: record.input.deploymentId,
      productionDomains: observation.productionDomains,
      domainDeploymentIds: observation.domainDeploymentIds,
      deploymentUrl: observation.deployment.url ?? null,
      changed: true,
      repairInstruction:
        "Do not promote or roll back. Restore the Notion incident property, then resume this exact promotion operation only to persist the canonical incident receipt.",
      message: `The health incident is durable in coordination state, but its canonical Notion incident receipt is pending (${code}).`,
    })
    record.result = recommendation
    try {
      await saveRecord(record, config, dependencies, lease)
    } catch {
      /* original durable recommendation remains */
    }
    return pending
  }
  recommendation = {
    ...recommendation,
    receiptWritten: true,
    records: recommendation.records.map((receiptRecord, index) =>
      index === 0
        ? { ...receiptRecord, action: "receipt_written" as const }
        : receiptRecord
    ),
  }
  assertPromotionResultSemantics(recommendation)
  record.result = recommendation
  try {
    await saveRecord(record, config, dependencies, lease)
  } catch (error) {
    const code =
      error instanceof SafetyError ? error.code : "COORDINATION_UNAVAILABLE"
    return {
      ...recommendation,
      message: `${recommendation.message} The canonical Notion incident is confirmed, but its final Redis update failed (${code}); do not promote or roll back without the fresh approval bound to this incident hash.`,
    }
  }
  return recommendation
}

async function persistConfirmedCompletion(
  record: OperationRecord,
  completed: PromotionResult,
  lease: LeaseIdentity,
  config: WorkerConfig,
  dependencies: RuntimeDependencies
): Promise<PromotionResult> {
  record.state = "complete"
  record.lastIssue = null
  record.result = completed
  try {
    await saveRecord(record, config, dependencies, lease)
    return completed
  } catch (error) {
    const code =
      error instanceof SafetyError ? error.code : "COORDINATION_UNAVAILABLE"
    return resultFor({
      operationId: record.operationId,
      status: "partial_failure",
      input: record.input,
      policy: record.policy,
      startedAt: record.createdAt,
      completedAt: completed.completedAt,
      promotionRequested: completed.promotionRequested,
      receiptWritten: true,
      currentDeploymentId: record.input.deploymentId,
      deploymentUrl: completed.deploymentUrl,
      changed: completed.changed,
      repairInstruction:
        "Do not promote again. The exact Notion receipt and provider state are confirmed; restore Redis coordination, then resume this operation to rebuild the durable completion record.",
      message: `Completion is confirmed, but the final durable record could not be saved (${code}).`,
    })
  }
}

async function finishReceipt(
  record: OperationRecord,
  lease: LeaseIdentity,
  config: WorkerConfig,
  dependencies: RuntimeDependencies,
  result: PromotionResult
): Promise<PromotionResult> {
  record.state = "receipt_pending"
  record.result = resultFor({
    operationId: record.operationId,
    status: "partial_failure",
    input: record.input,
    policy: record.policy,
    startedAt: record.createdAt,
    completedAt: result.completedAt,
    promotionRequested: result.promotionRequested,
    receiptWritten: false,
    currentDeploymentId: record.input.deploymentId,
    deploymentUrl: result.deploymentUrl,
    message: "Vercel promotion completed; the Notion receipt is pending.",
  })
  await saveRecord(record, config, dependencies, lease)
  await ensureLease(lease.key, lease.token, config, dependencies)
  try {
    await writePromotionReceipt(
      dependencies.notion,
      record.input,
      config.receiptProperty,
      result
    )
  } catch (error) {
    const detail =
      error instanceof SafetyError
        ? `${error.code}: ${error.message}`
        : "Receipt write failed."
    record.lastIssue =
      error instanceof SafetyError ? error.code : "RECEIPT_WRITE_FAILED"
    record.result = resultFor({
      operationId: record.operationId,
      status: "partial_failure",
      input: record.input,
      policy: record.policy,
      startedAt: record.createdAt,
      completedAt: result.completedAt,
      promotionRequested: result.promotionRequested,
      receiptWritten: false,
      currentDeploymentId: record.input.deploymentId,
      deploymentUrl: result.deploymentUrl,
      message: `Vercel promotion completed, but the Notion receipt is pending. ${detail}`,
    })
    await saveRecord(record, config, dependencies, lease)
    return record.result
  }
  let finalObservation: PromotionObservation
  try {
    await ensureLease(lease.key, lease.token, config, dependencies)
    finalObservation = await observePromotion(
      dependencies.vercel,
      record.policy,
      record.input.expectedCurrentDeploymentId,
      record.input.deploymentId
    )
    await ensureLease(lease.key, lease.token, config, dependencies)
  } catch (error) {
    const code =
      error instanceof SafetyError
        ? error.code
        : error instanceof VercelHttpError
          ? `VERCEL_READ_${error.status ?? "FAILED"}`
          : "FINAL_PROVIDER_READ_FAILED"
    record.state = "mutation_unknown"
    record.lastIssue = code
    record.result = resultFor({
      operationId: record.operationId,
      status: "partial_failure",
      input: record.input,
      policy: record.policy,
      startedAt: record.createdAt,
      completedAt: result.completedAt,
      promotionRequested: result.promotionRequested,
      receiptWritten: true,
      currentDeploymentId: null,
      deploymentUrl: result.deploymentUrl,
      repairInstruction:
        "Do not promote again. The receipt was confirmed, but final provider verification failed; investigate the dependency and resume this exact operation for read-only reconciliation.",
      message: `The Notion receipt is recorded, but final provider verification failed (${code}).`,
    })
    if (code !== "LEASE_LOST" && code !== "COORDINATION_UNAVAILABLE") {
      try {
        await saveRecord(record, config, dependencies, lease)
      } catch {
        // The durable receipt_pending record and Notion readback remain enough
        // for a future caller to reconcile without another promotion.
      }
    }
    return record.result
  }
  if (!isFullyPromoted(finalObservation)) {
    return persistPostTargetIncident(
      record,
      finalObservation,
      lease,
      config,
      dependencies,
      "POST_RECEIPT_PROVIDER_STATE_CHANGED",
      true,
      "The Notion receipt is recorded, but production changed during the final provider verification."
    )
  }
  const completed = resultFor({
    operationId: record.operationId,
    status: "completed",
    input: record.input,
    policy: record.policy,
    startedAt: record.createdAt,
    completedAt: result.completedAt,
    promotionRequested: result.promotionRequested,
    receiptWritten: true,
    currentDeploymentId: record.input.deploymentId,
    deploymentUrl: result.deploymentUrl,
    message:
      "The exact approved deployment owns the exact complete production-domain set and the Notion receipt is recorded.",
  })
  return persistConfirmedCompletion(
    record,
    completed,
    lease,
    config,
    dependencies
  )
}

async function finishPromotion(
  record: OperationRecord,
  observation: PromotionObservation,
  lease: LeaseIdentity,
  config: WorkerConfig,
  dependencies: RuntimeDependencies
): Promise<PromotionResult> {
  await ensureLease(lease.key, lease.token, config, dependencies)
  try {
    await dependencies.vercel.checkHealth(
      observation.deployment.url!,
      record.policy.healthPaths
    )
  } catch (error) {
    if (!(error instanceof HealthCheckFailure)) throw error
    await ensureLease(lease.key, lease.token, config, dependencies)
    const incidentObservation = await observePromotion(
      dependencies.vercel,
      record.policy,
      record.input.expectedCurrentDeploymentId,
      record.input.deploymentId
    )
    await ensureLease(lease.key, lease.token, config, dependencies)
    if (!isFullyPromoted(incidentObservation)) {
      return persistPostTargetIncident(
        record,
        incidentObservation,
        lease,
        config,
        dependencies,
        "POST_HEALTH_PROVIDER_STATE_CHANGED",
        false,
        "Post-promotion health failed and production changed before an incident recommendation could be persisted."
      )
    }
    return persistRollbackRecommendation(
      record,
      incidentObservation,
      error.evidence,
      lease,
      config,
      dependencies
    )
  }
  await ensureLease(lease.key, lease.token, config, dependencies)
  const finalObservation = await observePromotion(
    dependencies.vercel,
    record.policy,
    record.input.expectedCurrentDeploymentId,
    record.input.deploymentId
  )
  await ensureLease(lease.key, lease.token, config, dependencies)
  if (!isFullyPromoted(finalObservation)) {
    return persistPostTargetIncident(
      record,
      finalObservation,
      lease,
      config,
      dependencies,
      "FINAL_PROVIDER_STATE_CHANGED"
    )
  }
  const completedAt = iso(dependencies)
  const result = resultFor({
    operationId: record.operationId,
    status: "completed",
    input: record.input,
    policy: record.policy,
    startedAt: record.createdAt,
    completedAt,
    promotionRequested: record.mutationAttempts > 0,
    receiptWritten: false,
    currentDeploymentId: record.input.deploymentId,
    deploymentUrl: finalObservation.deployment.url ?? null,
    message: "Vercel promotion converged; recording the Notion receipt.",
  })
  return finishReceipt(record, lease, config, dependencies, result)
}

async function resumeRollbackRecommendation(
  record: OperationRecord,
  lease: LeaseIdentity,
  config: WorkerConfig,
  dependencies: RuntimeDependencies
): Promise<PromotionResult> {
  const recommendation = record.result
  if (!recommendation || recommendation.status !== "rollback_recommended") {
    throw new SafetyError(
      "COORDINATION_CORRUPT",
      "The durable incident recommendation is missing."
    )
  }
  await ensureLease(lease.key, lease.token, config, dependencies)
  const approval = await retrieveApproval(
    dependencies.notion,
    record.input.approvalPageId,
    config.incidentProperty ?? "Promotion incident",
    16_000
  )
  verifyApproval(approval, record.input, { requireRevision: true })
  const canonical = canonicalPromotionIncidentJson(recommendation)
  if (approval.receiptText && approval.receiptText !== canonical) {
    throw new SafetyError(
      "INCIDENT_RECEIPT_MISMATCH",
      "The canonical promotion incident changed."
    )
  }
  const observation = await observePromotion(
    dependencies.vercel,
    record.policy,
    record.input.expectedCurrentDeploymentId,
    record.input.deploymentId
  )
  await ensureLease(lease.key, lease.token, config, dependencies)
  if (!isFullyPromoted(observation)) {
    return resultFor({
      operationId: record.operationId,
      status:
        observation.classification === "partial"
          ? "partial_failure"
          : "conflict",
      input: record.input,
      policy: record.policy,
      startedAt: record.createdAt,
      completedAt: recommendation.completedAt,
      promotionRequested: false,
      receiptWritten: approval.receiptText === canonical,
      currentDeploymentId: observation.currentDeploymentId,
      productionDomains: observation.productionDomains,
      domainDeploymentIds: observation.domainDeploymentIds,
      deploymentUrl: observation.deployment.url ?? recommendation.deploymentUrl,
      changed: false,
      retryable: false,
      repairInstruction:
        "Do not use the stale rollback recommendation. Investigate live production state and require a new incident decision.",
      message:
        "Live production no longer matches the candidate state captured by the rollback recommendation.",
    })
  }
  if (!approval.receiptText) {
    await writePromotionIncidentReceipt(
      dependencies.notion,
      record.input,
      config.incidentProperty ?? "Promotion incident",
      recommendation
    )
  }
  const durable = {
    ...recommendation,
    receiptWritten: true,
    records: recommendation.records.map((receiptRecord, index) =>
      index === 0
        ? { ...receiptRecord, action: "receipt_written" as const }
        : receiptRecord
    ),
  }
  assertPromotionResultSemantics(durable)
  record.result = durable
  await saveRecord(record, config, dependencies, lease)
  return durable
}

function isFullyPromoted(observation: PromotionObservation): boolean {
  return (
    observation.classification === "target_current" &&
    observation.deployment.readyState === "READY" &&
    observation.deployment.readySubstate === "PROMOTED"
  )
}

async function reconcile(
  record: OperationRecord,
  leaseKey: string,
  leaseToken: string,
  config: WorkerConfig,
  dependencies: RuntimeDependencies,
  poll: boolean
): Promise<PromotionResult> {
  const lease = { key: leaseKey, token: leaseToken }
  const deadline =
    dependencies.now().getTime() + (poll ? config.pollTimeoutMs : 0)
  const maximumAttempts = poll ? config.pollMaxAttempts : 1
  let attempts = 0
  let lastObservation: PromotionObservation | null = null
  let lastIssue = record.lastIssue ?? "RECONCILIATION_PENDING"
  do {
    attempts++
    await ensureLease(leaseKey, leaseToken, config, dependencies)
    try {
      const observation = await observePromotion(
        dependencies.vercel,
        record.policy,
        record.input.expectedCurrentDeploymentId,
        record.input.deploymentId
      )
      await ensureLease(leaseKey, leaseToken, config, dependencies)
      lastObservation = observation
      if (isFullyPromoted(observation)) {
        return await finishPromotion(
          record,
          observation,
          lease,
          config,
          dependencies
        )
      }
      if (observation.classification === "other_current") {
        return persistUnresolved(
          record,
          observation,
          lease,
          config,
          dependencies,
          "EXTERNAL_PROMOTION_CONFLICT"
        )
      }
      lastIssue = `OBSERVED_${observation.classification.toUpperCase()}`
    } catch (error) {
      lastIssue =
        error instanceof SafetyError
          ? error.code
          : error instanceof VercelHttpError
            ? `VERCEL_READ_${error.status ?? "FAILED"}`
            : "RECONCILIATION_READ_FAILED"
    }
    if (attempts >= maximumAttempts || dependencies.now().getTime() >= deadline)
      break
    await dependencies.sleep(config.pollIntervalMs)
  } while (true)
  return persistUnresolved(
    record,
    lastObservation,
    lease,
    config,
    dependencies,
    lastIssue
  )
}

async function resumeReceipt(
  record: OperationRecord,
  leaseKey: string,
  leaseToken: string,
  config: WorkerConfig,
  dependencies: RuntimeDependencies
): Promise<PromotionResult> {
  const lease = { key: leaseKey, token: leaseToken }
  await ensureLease(leaseKey, leaseToken, config, dependencies)
  const approval = await retrieveApproval(
    dependencies.notion,
    record.input.approvalPageId,
    config.receiptProperty
  )
  verifyApproval(approval, record.input, { requireRevision: true })
  const receiptWritten =
    matchingStoredReceipt(approval, record.input, record.operationId) !== null
  let observation: PromotionObservation
  try {
    await ensureLease(leaseKey, leaseToken, config, dependencies)
    observation = await observePromotion(
      dependencies.vercel,
      record.policy,
      record.input.expectedCurrentDeploymentId,
      record.input.deploymentId
    )
    await ensureLease(leaseKey, leaseToken, config, dependencies)
  } catch (error) {
    if (!receiptWritten) throw error
    const issue =
      error instanceof SafetyError
        ? error.code
        : error instanceof VercelHttpError
          ? `VERCEL_READ_${error.status ?? "FAILED"}`
          : "RECONCILIATION_READ_FAILED"
    return persistUnresolved(
      record,
      null,
      lease,
      config,
      dependencies,
      issue,
      true
    )
  }
  if (!isFullyPromoted(observation)) {
    return persistUnresolved(
      record,
      observation,
      lease,
      config,
      dependencies,
      "RECEIPT_RESUME_STATE_CHANGED",
      receiptWritten
    )
  }
  const base = record.result
  if (!base?.completedAt) {
    return finishPromotion(record, observation, lease, config, dependencies)
  }
  return finishReceipt(
    record,
    lease,
    config,
    dependencies,
    resultFor({
      operationId: record.operationId,
      status: "completed",
      input: record.input,
      policy: record.policy,
      startedAt: record.createdAt,
      completedAt: base.completedAt,
      promotionRequested: base.promotionRequested,
      receiptWritten: false,
      currentDeploymentId: record.input.deploymentId,
      deploymentUrl: observation.deployment.url ?? base.deploymentUrl,
      message: "Production is converged; resuming receipt-only writeback.",
    })
  )
}

function completedReplayDriftResult(
  record: OperationRecord,
  observation: PromotionObservation,
  receiptWritten: boolean,
  message: string
): PromotionResult {
  const status =
    observation.classification === "partial" ||
    observation.classification === "target_current"
      ? "partial_failure"
      : "conflict"
  return resultFor({
    operationId: record.operationId,
    status,
    input: record.input,
    policy: record.policy,
    startedAt: record.createdAt,
    completedAt: record.result?.completedAt ?? null,
    promotionRequested: false,
    receiptWritten,
    currentDeploymentId: observation.currentDeploymentId,
    productionDomains: observation.productionDomains,
    domainDeploymentIds: observation.domainDeploymentIds,
    deploymentUrl:
      observation.deployment.url ?? record.result?.deploymentUrl ?? null,
    changed: false,
    retryable: status === "partial_failure",
    repairInstruction:
      "Do not reuse the completed approval to promote again. Investigate the live production state; if another release is intended, create a new human approval revision.",
    message,
  })
}

async function verifyCompletedReplay(
  record: OperationRecord,
  lease: LeaseIdentity,
  config: WorkerConfig,
  dependencies: RuntimeDependencies
): Promise<PromotionResult> {
  await ensureLease(lease.key, lease.token, config, dependencies)
  const approval = await retrieveApproval(
    dependencies.notion,
    record.input.approvalPageId,
    config.receiptProperty
  )
  verifyApproval(approval, record.input, { requireRevision: true })
  await ensureLease(lease.key, lease.token, config, dependencies)

  const observation = await observePromotion(
    dependencies.vercel,
    record.policy,
    record.input.expectedCurrentDeploymentId,
    record.input.deploymentId
  )
  await ensureLease(lease.key, lease.token, config, dependencies)
  const stored = matchingStoredReceipt(
    approval,
    record.input,
    record.operationId
  )
  if (!isFullyPromoted(observation)) {
    return completedReplayDriftResult(
      record,
      observation,
      stored !== null,
      "This operation completed previously, but the live production domains no longer prove that the approved deployment is current."
    )
  }

  try {
    await dependencies.vercel.checkHealth(
      observation.deployment.url!,
      record.policy.healthPaths
    )
  } catch (error) {
    const issue =
      error instanceof SafetyError
        ? `${error.code}: ${error.message}`
        : "Health failed."
    return resultFor({
      operationId: record.operationId,
      status: "partial_failure",
      input: record.input,
      policy: record.policy,
      startedAt: record.createdAt,
      completedAt: record.result?.completedAt ?? null,
      promotionRequested: false,
      receiptWritten: stored !== null,
      currentDeploymentId: record.input.deploymentId,
      deploymentUrl: observation.deployment.url ?? null,
      changed: false,
      repairInstruction:
        "Do not promote again. Investigate the live health failure, then resume this exact operation for read-only verification.",
      message: `The completed operation still routes to the approved deployment, but live health verification failed. ${issue}`,
    })
  }
  await ensureLease(lease.key, lease.token, config, dependencies)

  const finalObservation = await observePromotion(
    dependencies.vercel,
    record.policy,
    record.input.expectedCurrentDeploymentId,
    record.input.deploymentId
  )
  await ensureLease(lease.key, lease.token, config, dependencies)
  if (!isFullyPromoted(finalObservation)) {
    return completedReplayDriftResult(
      record,
      finalObservation,
      stored !== null,
      "This operation completed previously, but production changed during live replay verification."
    )
  }

  const finalApproval = await retrieveApproval(
    dependencies.notion,
    record.input.approvalPageId,
    config.receiptProperty
  )
  verifyApproval(finalApproval, record.input, { requireRevision: true })
  await ensureLease(lease.key, lease.token, config, dependencies)
  const finalStored = matchingStoredReceipt(
    finalApproval,
    record.input,
    record.operationId
  )
  if (!finalStored) {
    return finishReceipt(
      record,
      lease,
      config,
      dependencies,
      resultFor({
        operationId: record.operationId,
        status: "completed",
        input: record.input,
        policy: record.policy,
        startedAt: record.createdAt,
        completedAt: record.result?.completedAt ?? iso(dependencies),
        promotionRequested: false,
        receiptWritten: false,
        currentDeploymentId: record.input.deploymentId,
        deploymentUrl: finalObservation.deployment.url ?? null,
        message:
          "Live provider state is still authoritative; restoring the missing Notion receipt without another promotion.",
      })
    )
  }

  return resultFor({
    operationId: record.operationId,
    status: "no_op",
    input: record.input,
    policy: record.policy,
    startedAt: record.createdAt,
    completedAt: finalStored.verifiedAt,
    promotionRequested: false,
    receiptWritten: true,
    currentDeploymentId: finalObservation.currentDeploymentId,
    deploymentUrl: finalObservation.deployment.url ?? null,
    message:
      "Live provider state and the Notion receipt prove this exact operation remains complete; no Vercel mutation was issued.",
  })
}

async function reconstructCompletedReplay(
  input: PromoteInput,
  policy: TargetPolicy,
  operationId: string,
  invokedAt: string,
  leaseKey: string,
  leaseToken: string,
  config: WorkerConfig,
  dependencies: RuntimeDependencies
): Promise<PromotionResult | null> {
  const lease = { key: leaseKey, token: leaseToken }
  await ensureLease(leaseKey, leaseToken, config, dependencies)
  const approval = await retrieveApproval(
    dependencies.notion,
    input.approvalPageId,
    config.receiptProperty
  )
  verifyApproval(approval, input, { requireRevision: true })
  const initialStored = matchingStoredReceipt(approval, input, operationId)
  if (approval.receiptText !== "" && !initialStored) {
    throw new SafetyError(
      "RECEIPT_OCCUPIED",
      "The Notion receipt property contains non-canonical or non-matching content."
    )
  }
  await ensureLease(leaseKey, leaseToken, config, dependencies)
  const observation = await observePromotion(
    dependencies.vercel,
    policy,
    input.expectedCurrentDeploymentId,
    input.deploymentId
  )
  await ensureLease(leaseKey, leaseToken, config, dependencies)
  if (!isFullyPromoted(observation)) return null
  verifyPromotedDeploymentIdentity({
    deployment: observation.deployment,
    teamId: input.teamId,
    projectId: input.projectId,
    deploymentId: input.deploymentId,
    expectedGitSha: input.expectedGitSha,
    expectedGitBranch: input.expectedGitBranch,
  })
  await dependencies.vercel.checkHealth(
    observation.deployment.url!,
    policy.healthPaths
  )
  await ensureLease(leaseKey, leaseToken, config, dependencies)

  const finalObservation = await observePromotion(
    dependencies.vercel,
    policy,
    input.expectedCurrentDeploymentId,
    input.deploymentId
  )
  await ensureLease(leaseKey, leaseToken, config, dependencies)
  if (!isFullyPromoted(finalObservation)) return null
  verifyPromotedDeploymentIdentity({
    deployment: finalObservation.deployment,
    teamId: input.teamId,
    projectId: input.projectId,
    deploymentId: input.deploymentId,
    expectedGitSha: input.expectedGitSha,
    expectedGitBranch: input.expectedGitBranch,
  })

  const finalApproval = await retrieveApproval(
    dependencies.notion,
    input.approvalPageId,
    config.receiptProperty
  )
  verifyApproval(finalApproval, input, { requireRevision: true })
  await ensureLease(leaseKey, leaseToken, config, dependencies)

  let stored = matchingStoredReceipt(finalApproval, input, operationId)
  if (finalApproval.receiptText !== "" && !stored) {
    throw new SafetyError(
      "RECEIPT_OCCUPIED",
      "The Notion receipt property changed to non-canonical or non-matching content."
    )
  }
  if (initialStored && !stored) {
    throw new SafetyError(
      "RECEIPT_CHANGED",
      "The exact canonical receipt disappeared during reconstruction."
    )
  }

  let authoritativeObservation = finalObservation
  if (!stored) {
    const [definitions, runs] = await Promise.all([
      dependencies.vercel.getCheckDefinitions(input.teamId, input.projectId),
      dependencies.vercel.getCheckRuns(input.teamId, input.deploymentId),
    ])
    verifyDeploymentChecks({
      definitions,
      runs,
      policy,
      deployment: finalObservation.deployment,
      projectId: input.projectId,
      now: dependencies.now(),
      maxAgeMs: config.checkMaxAgeMs,
    })
    await ensureLease(leaseKey, leaseToken, config, dependencies)
    authoritativeObservation = await observePromotion(
      dependencies.vercel,
      policy,
      input.expectedCurrentDeploymentId,
      input.deploymentId
    )
    await ensureLease(leaseKey, leaseToken, config, dependencies)
    if (!isFullyPromoted(authoritativeObservation)) return null
    verifyPromotedDeploymentIdentity({
      deployment: authoritativeObservation.deployment,
      teamId: input.teamId,
      projectId: input.projectId,
      deploymentId: input.deploymentId,
      expectedGitSha: input.expectedGitSha,
      expectedGitBranch: input.expectedGitBranch,
    })
  }

  const record = newRecord(operationId, input, policy, invokedAt)
  const completedAt = stored?.verifiedAt ?? iso(dependencies)
  const completed = resultFor({
    operationId,
    status: "completed",
    input,
    policy,
    startedAt: invokedAt,
    completedAt,
    promotionRequested: false,
    receiptWritten: stored !== null,
    currentDeploymentId: input.deploymentId,
    deploymentUrl: authoritativeObservation.deployment.url ?? null,
    message:
      "The approved deployment is already authoritative; rebuilding the durable canonical replay record.",
  })
  let persisted: PromotionResult
  if (stored) {
    persisted = await persistConfirmedCompletion(
      record,
      completed,
      lease,
      config,
      dependencies
    )
    if (persisted.status !== "completed") return persisted
  } else {
    persisted = await finishReceipt(
      record,
      lease,
      config,
      dependencies,
      completed
    )
    if (persisted.status !== "completed") return persisted
  }
  return resultFor({
    operationId,
    status: "no_op",
    input,
    policy,
    startedAt: invokedAt,
    completedAt: persisted.completedAt,
    promotionRequested: false,
    receiptWritten: true,
    currentDeploymentId: input.deploymentId,
    deploymentUrl: authoritativeObservation.deployment.url ?? null,
    message:
      "The provider and Notion receipt prove this exact operation is already complete; no Vercel mutation was issued.",
  })
}

function safeRuntimeInput(value: unknown): PromoteInput {
  const object =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const exact = (name: string, fallback: string, maximum: number): string => {
    const candidate = object[name]
    return typeof candidate === "string" &&
      candidate.length > 0 &&
      candidate.length <= maximum &&
      candidate.trim() === candidate &&
      !/[\u0000-\u001f\u007f]/.test(candidate)
      ? candidate
      : fallback
  }
  const matching = (
    name: string,
    pattern: RegExp,
    fallback: string
  ): string => {
    const candidate = object[name]
    return typeof candidate === "string" && pattern.test(candidate)
      ? candidate
      : fallback
  }
  return {
    approvalPageId: matching(
      "approvalPageId",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      "00000000-0000-4000-8000-000000000000"
    ),
    approvalRevision: exact("approvalRevision", "invalid", 100),
    approvalFingerprint: matching(
      "approvalFingerprint",
      /^[0-9a-f]{64}$/,
      "0".repeat(64)
    ),
    teamId: matching("teamId", TEAM_ID, "team_invalid"),
    projectId: matching("projectId", PROJECT_ID, "prj_invalid"),
    deploymentId: matching("deploymentId", DEPLOYMENT_ID, "dpl_invalid"),
    expectedGitSha: matching(
      "expectedGitSha",
      /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/,
      "0".repeat(40)
    ),
    expectedGitBranch: exact("expectedGitBranch", "invalid", 256),
    expectedCurrentDeploymentId: matching(
      "expectedCurrentDeploymentId",
      DEPLOYMENT_ID,
      "dpl_invalid"
    ),
  }
}

function validationFailureResult(
  value: unknown,
  dependencies: RuntimeDependencies,
  error: unknown
): PromotionResult {
  const input = safeRuntimeInput(value)
  const policy: TargetPolicy = {
    teamId: input.teamId,
    projectId: input.projectId,
    productionDomains: [],
    deploymentChecks: [],
    healthPaths: [],
  }
  const { operationId } = operationIdentity(input)
  const code = error instanceof SafetyError ? error.code : "INVALID_INPUT"
  const message =
    error instanceof SafetyError
      ? error.message
      : "The tool input did not match the required bounded object shape."
  return resultFor({
    operationId,
    status: "blocked",
    input,
    policy,
    startedAt: iso(dependencies),
    promotionRequested: false,
    receiptWritten: false,
    preconditionsVerified: false,
    retryable: false,
    repairInstruction:
      code === "TARGET_NOT_ALLOWLISTED"
        ? "Ask an operator to add the exact team/project pair to the fixed Worker allowlist; do not substitute another target."
        : "Correct the malformed tool arguments from the approved Notion properties, then ask the user to confirm a new call.",
    message: `${code}: ${message}`,
  })
}

export async function promoteApprovedDeployment(
  input: PromoteInput,
  config: WorkerConfig,
  dependencies: RuntimeDependencies
): Promise<PromotionResult> {
  let policy: TargetPolicy
  try {
    validatePromoteInput(input)
    policy = findTargetPolicy(config, input)
    assertLeaseBudget(config)
  } catch (error) {
    return validationFailureResult(input, dependencies, error)
  }
  const { operationId, leaseKey } = operationIdentity(input)
  const leaseToken = dependencies.randomToken()
  const lease = { key: leaseKey, token: leaseToken }
  const invokedAt = iso(dependencies)
  let acquired: boolean
  try {
    acquired = await dependencies.store.acquireLease(
      leaseKey,
      leaseToken,
      config.leaseTtlMs
    )
  } catch (error) {
    const code =
      error instanceof SafetyError ? error.code : "COORDINATION_UNAVAILABLE"
    const detail =
      error instanceof SafetyError
        ? error.message
        : "The Redis coordination service is unavailable."
    return resultFor({
      operationId,
      status: "blocked",
      input,
      policy,
      startedAt: invokedAt,
      promotionRequested: false,
      receiptWritten: false,
      preconditionsVerified: false,
      retryable: true,
      repairInstruction:
        "Restore Redis coordination, then call the exact same approved operation; no Vercel mutation was attempted.",
      message: `${code}: ${detail}`,
    })
  }
  if (!acquired) {
    return resultFor({
      operationId,
      status: "blocked",
      input,
      policy,
      startedAt: invokedAt,
      promotionRequested: false,
      receiptWritten: false,
      retryable: true,
      repairInstruction:
        "Wait for the project-wide lease to expire, then call the exact same approved operation.",
      message:
        "A project-wide promotion lease is already held. Retry the same operation after it expires.",
    })
  }

  let record: OperationRecord | null = null
  let mutationStarted = false
  let verifiedDeploymentUrl: string | null = null
  try {
    record = await dependencies.store.getOperation(operationId)
    if (record) {
      assertRecordIdentity(record, input, policy)
      mutationStarted =
        record.state === "mutation_started" ||
        record.state === "mutation_unknown" ||
        record.state === "receipt_pending"
      if (record.result?.status === "rollback_recommended") {
        return await resumeRollbackRecommendation(
          record,
          lease,
          config,
          dependencies
        )
      }
      if (record.state === "complete" && record.result) {
        return await verifyCompletedReplay(record, lease, config, dependencies)
      }
      if (record.state === "receipt_pending") {
        return await resumeReceipt(
          record,
          leaseKey,
          leaseToken,
          config,
          dependencies
        )
      }
      if (
        record.state === "mutation_started" ||
        record.state === "mutation_unknown"
      ) {
        return await reconcile(
          record,
          leaseKey,
          leaseToken,
          config,
          dependencies,
          false
        )
      }
    }

    if (!record) {
      const reconstructed = await reconstructCompletedReplay(
        input,
        policy,
        operationId,
        invokedAt,
        leaseKey,
        leaseToken,
        config,
        dependencies
      )
      if (reconstructed) return reconstructed
    }

    // Validate once before writing durable intent, then repeat all mutable reads
    // under the lease immediately before the irreversible request.
    verifiedDeploymentUrl = await verifyPreconditions(
      input,
      policy,
      config,
      dependencies
    )
    record ??= newRecord(operationId, input, policy, invokedAt)
    await saveRecord(record, config, dependencies, lease)
    await ensureLease(leaseKey, leaseToken, config, dependencies)
    verifiedDeploymentUrl = await verifyPreconditions(
      input,
      policy,
      config,
      dependencies
    )
    await ensureLease(leaseKey, leaseToken, config, dependencies)

    record.state = "mutation_started"
    record.mutationStartedAt = iso(dependencies)
    record.mutationAttempts += 1
    record.lastIssue = null
    mutationStarted = true
    await saveRecord(record, config, dependencies, lease)
    // The durable mutation_started write can consume a Redis attempt. Fence the
    // irreversible request with a fresh token-owned TTL after that write.
    await ensureLease(leaseKey, leaseToken, config, dependencies)

    try {
      const accepted = await dependencies.vercel.requestPromotion(
        input.teamId,
        input.projectId,
        input.deploymentId
      )
      record.lastMutationStatus = accepted.status
      record.promotionAcceptedAt = iso(dependencies)
      await saveRecord(record, config, dependencies, lease)
    } catch (error) {
      if (error instanceof VercelHttpError) {
        record.lastMutationStatus = error.status
        if (
          !error.ambiguous &&
          isDefinitePromotionRejectionStatus(error.status)
        ) {
          const retryable = error.status === 429
          const retryAfterMs = retryable
            ? Math.min(Math.max(error.retryAfterMs ?? 0, 0), 300_000)
            : null
          record.state = "prepared"
          record.lastIssue = `PROMOTION_HTTP_${error.status ?? "FAILED"}`
          record.result = resultFor({
            operationId,
            status: "blocked",
            input,
            policy,
            startedAt: record.createdAt,
            promotionRequested: true,
            receiptWritten: false,
            currentDeploymentId: input.expectedCurrentDeploymentId,
            deploymentUrl: verifiedDeploymentUrl,
            retryable,
            retryAfterMs,
            preconditionsVerified: true,
            repairInstruction: retryable
              ? `Wait at least ${retryAfterMs} ms, then call the exact same approved operation; every precondition will be revalidated.`
              : "Repair Vercel authentication, authorization, or request policy before calling the exact same approved operation.",
            message: `Vercel definitely rejected the promotion with HTTP ${error.status}; no reconciliation or automatic retry was needed.`,
          })
          await saveRecord(record, config, dependencies, lease)
          mutationStarted = false
          return record.result
        }
        record.lastIssue =
          error.status === 409
            ? "PROMOTION_HTTP_409"
            : error.ambiguous
              ? "PROMOTION_AMBIGUOUS"
              : `PROMOTION_HTTP_${error.status ?? "FAILED"}`
      } else {
        record.lastIssue = "PROMOTION_AMBIGUOUS"
      }
      record.state = "mutation_unknown"
      await saveRecord(record, config, dependencies, lease)
    }

    // Accepted, timed out, and every response outside the closed definite
    // rejection set cross the same read-only reconciliation boundary. This
    // operation never issues a second POST.
    return await reconcile(
      record,
      leaseKey,
      leaseToken,
      config,
      dependencies,
      true
    )
  } catch (error) {
    const code =
      error instanceof SafetyError
        ? error.code
        : error instanceof VercelHttpError
          ? `VERCEL_${error.status ?? "FAILED"}`
          : "UNEXPECTED_FAILURE"
    const message =
      error instanceof SafetyError || error instanceof VercelHttpError
        ? error.message
        : "A dependency failed without a safe diagnostic."
    if (
      mutationStarted &&
      record?.state === "prepared" &&
      record.result?.status === "blocked" &&
      typeof record.lastMutationStatus === "number" &&
      isDefinitePromotionRejectionStatus(record.lastMutationStatus)
    ) {
      return {
        ...record.result,
        repairInstruction: `Restore Redis coordination. ${record.result.repairInstruction}`,
        message: `${record.result.message} The definite rejection was observed, but its durable record could not be confirmed (${code}).`,
      }
    }
    if (record && mutationStarted) {
      try {
        if (code !== "LEASE_LOST" && code !== "COORDINATION_UNAVAILABLE") {
          record.state = "mutation_unknown"
          record.lastIssue = code
          await saveRecord(record, config, dependencies, lease)
        }
      } catch {
        // The mutation_started record was persisted before POST; do not hide the
        // original failure or attempt another mutation when coordination is down.
      }
      return resultFor({
        operationId,
        status: "ambiguous",
        input,
        policy,
        startedAt: record.createdAt,
        promotionRequested: true,
        receiptWritten: false,
        deploymentUrl: record.result?.deploymentUrl ?? verifiedDeploymentUrl,
        message: `The mutation boundary was crossed, so no retry was attempted. ${code}: ${message}`,
      })
    }
    return resultFor({
      operationId,
      status: "blocked",
      input,
      policy,
      startedAt: record?.createdAt ?? invokedAt,
      promotionRequested: false,
      receiptWritten: false,
      productionDomains:
        error instanceof ProjectAliasSetMismatchError
          ? error.productionDomains
          : undefined,
      domainDeploymentIds:
        error instanceof ProjectAliasSetMismatchError
          ? error.domainDeploymentIds
          : undefined,
      deploymentUrl: verifiedDeploymentUrl,
      message: `${code}: ${message}`,
    })
  } finally {
    try {
      await dependencies.store.releaseLease(leaseKey, leaseToken)
    } catch {
      // Token-checked lease expiry is safe; never expose coordination secrets.
    }
  }
}
