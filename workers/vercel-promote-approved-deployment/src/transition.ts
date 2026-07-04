import {
  canonicalReceiptJson,
  createReceipt,
  readApproval,
  writeReceipt,
} from "./notion.js"
import type {
  ApprovalSnapshot,
  ProductionObservation,
  TransitionAction,
  TransitionDependencies,
  TransitionInput,
  TransitionResult,
  WorkerConfig,
} from "./types.js"
import { SafetyError, VercelHttpError } from "./types.js"

const RECONCILIATION_ATTEMPTS = 3
const RECONCILIATION_DELAY_MS = 1_000

function result(options: {
  action: TransitionAction
  approval?: ApprovalSnapshot | null
  status: TransitionResult["status"]
  changed?: boolean
  requestAttempted?: boolean
  receiptState?: TransitionResult["receiptState"]
  currentDeploymentId?: string | null
  retryable?: boolean
  nextStep?: string | null
  message: string
}): TransitionResult {
  return {
    ok: options.status === "completed" || options.status === "no_op",
    status: options.status,
    action: options.action,
    operationId: options.approval?.operationId ?? "unavailable",
    changed: options.changed ?? false,
    requestAttempted: options.requestAttempted ?? false,
    receiptState:
      options.receiptState ?? options.approval?.receipt?.state ?? "none",
    targetDeploymentId: options.approval?.targetDeploymentId ?? null,
    currentDeploymentId: options.currentDeploymentId ?? null,
    retryable: options.retryable ?? false,
    nextStep: options.nextStep ?? null,
    message: options.message,
  }
}

function assertConfiguredApproval(
  approval: ApprovalSnapshot,
  config: WorkerConfig
): void {
  if (
    approval.teamId !== config.teamId ||
    approval.projectId !== config.projectId
  ) {
    throw new SafetyError(
      "PROJECT_NOT_CONFIGURED",
      "The approval does not match this Worker's fixed Vercel team and project."
    )
  }
  if (approval.targetDeploymentId === approval.expectedCurrentDeploymentId) {
    throw new SafetyError(
      "INVALID_TRANSITION",
      "The target and expected current deployment must be different."
    )
  }
}

function sameApproval(
  first: ApprovalSnapshot,
  second: ApprovalSnapshot
): boolean {
  return (
    first.pageId === second.pageId &&
    first.action === second.action &&
    first.revision === second.revision &&
    first.teamId === second.teamId &&
    first.projectId === second.projectId &&
    first.expectedCurrentDeploymentId === second.expectedCurrentDeploymentId &&
    first.targetDeploymentId === second.targetDeploymentId &&
    first.gitSha === second.gitSha &&
    first.operationId === second.operationId
  )
}

function routingState(
  observation: ProductionObservation,
  approval: ApprovalSnapshot
): "expected" | "target" | "conflict" {
  if (!observation.exactDomainSet) return "conflict"
  if (observation.currentDeploymentId === approval.targetDeploymentId) {
    return "target"
  }
  if (
    observation.currentDeploymentId === approval.expectedCurrentDeploymentId
  ) {
    return "expected"
  }
  return "conflict"
}

async function verifyPreconditions(
  action: TransitionAction,
  approval: ApprovalSnapshot,
  config: WorkerConfig,
  dependencies: TransitionDependencies
): Promise<{
  state: "expected" | "target" | "conflict"
  observation: ProductionObservation
}> {
  assertConfiguredApproval(approval, config)
  const [observation] = await Promise.all([
    dependencies.vercel.observeProduction(
      config.teamId,
      config.projectId,
      config.productionDomains
    ),
    dependencies.vercel.assertRollingReleasesDisabled(
      config.teamId,
      config.projectId
    ),
  ])
  const state = routingState(observation, approval)
  const deployment = await dependencies.vercel.verifyDeployment(
    config.teamId,
    config.projectId,
    approval.targetDeploymentId,
    approval.gitSha,
    state === "target" || action === "rollback" ? "promoted" : "staged"
  )
  if (action === "promote") {
    await dependencies.vercel.verifyDeploymentChecks(
      config.teamId,
      config.projectId,
      approval.targetDeploymentId,
      config.deploymentCheckIds
    )
  }
  await dependencies.vercel.checkDeploymentHealth(
    deployment.url,
    config.healthPaths
  )
  return { state, observation }
}

async function completeReceipt(
  action: TransitionAction,
  approval: ApprovalSnapshot,
  config: WorkerConfig,
  dependencies: TransitionDependencies,
  requestAttempted: boolean
): Promise<TransitionResult> {
  const beforeReceipt = await dependencies.vercel.observeProduction(
    config.teamId,
    config.projectId,
    config.productionDomains
  )
  if (routingState(beforeReceipt, approval) !== "target") {
    return result({
      action,
      approval,
      status: "conflict",
      changed: requestAttempted,
      requestAttempted,
      currentDeploymentId: beforeReceipt.currentDeploymentId,
      retryable: true,
      nextStep:
        "Production changed during verification. Inspect Vercel before creating a new approval.",
      message:
        "The target was observed, but production changed before the completed receipt was written.",
    })
  }
  try {
    await writeReceipt(dependencies.notion, {
      pageId: approval.pageId,
      parentId: config.approvalParentId,
      expectedAction: action,
      receipt: createReceipt(approval, "completed", dependencies.now()),
    })
  } catch (error) {
    const code =
      error instanceof SafetyError ? error.code : "RECEIPT_WRITE_FAILED"
    return result({
      action,
      approval,
      status: "ambiguous",
      changed: requestAttempted,
      requestAttempted,
      receiptState: approval.receipt?.state ?? "none",
      currentDeploymentId: approval.targetDeploymentId,
      retryable: true,
      nextStep:
        "Run the same tool again to reconcile the existing approval; do not create another traffic request.",
      message: `Production is on the approved deployment, but the completed Notion receipt could not be confirmed (${code}).`,
    })
  }
  let afterReceipt: ProductionObservation
  try {
    afterReceipt = await dependencies.vercel.observeProduction(
      config.teamId,
      config.projectId,
      config.productionDomains
    )
  } catch (error) {
    const code =
      error instanceof SafetyError
        ? error.code
        : error instanceof VercelHttpError
          ? `VERCEL_${error.status ?? "READ_FAILED"}`
          : "FINAL_PROVIDER_READ_FAILED"
    return result({
      action,
      approval,
      status: "ambiguous",
      changed: requestAttempted,
      requestAttempted,
      receiptState: "completed",
      currentDeploymentId: approval.targetDeploymentId,
      retryable: true,
      nextStep:
        "The completed receipt is recorded. Inspect live Vercel state before any new approval.",
      message: `The completed receipt is recorded, but the final Vercel read failed (${code}).`,
    })
  }
  if (routingState(afterReceipt, approval) !== "target") {
    return result({
      action,
      approval,
      status: "conflict",
      changed: requestAttempted,
      requestAttempted,
      receiptState: "completed",
      currentDeploymentId: afterReceipt.currentDeploymentId,
      nextStep:
        "Production changed after this receipt completed. Use a new approval for any new traffic change.",
      message:
        "The completed receipt is recorded, but live production changed during final verification.",
    })
  }
  return result({
    action,
    approval,
    status: requestAttempted ? "completed" : "no_op",
    changed: requestAttempted,
    requestAttempted,
    receiptState: "completed",
    currentDeploymentId: approval.targetDeploymentId,
    message: requestAttempted
      ? `Vercel ${action === "promote" ? "promotion" : "rollback"} completed and every configured production domain is healthy.`
      : "Production already uses the approved deployment; the Worker recorded the observed state without another request.",
  })
}

async function reconcile(
  action: TransitionAction,
  approval: ApprovalSnapshot,
  config: WorkerConfig,
  dependencies: TransitionDependencies,
  requestAttempted: boolean
): Promise<TransitionResult> {
  let observation: ProductionObservation | null = null
  for (let attempt = 0; attempt < RECONCILIATION_ATTEMPTS; attempt++) {
    observation = await dependencies.vercel.observeProduction(
      config.teamId,
      config.projectId,
      config.productionDomains
    )
    const state = routingState(observation, approval)
    if (state === "target") {
      try {
        await dependencies.vercel.checkProductionHealth(
          config.productionDomains,
          config.healthPaths
        )
      } catch (error) {
        const code =
          error instanceof SafetyError ? error.code : "HEALTH_CHECK_FAILED"
        return result({
          action,
          approval,
          status: "ambiguous",
          changed: requestAttempted,
          requestAttempted,
          receiptState: "request_started",
          currentDeploymentId: approval.targetDeploymentId,
          retryable: true,
          nextStep:
            "Check the configured production health endpoints, then reconcile this same approval without repeating the traffic request.",
          message: `Production routes to the approved deployment, but its health checks failed (${code}).`,
        })
      }
      return completeReceipt(
        action,
        approval,
        config,
        dependencies,
        requestAttempted
      )
    }
    if (state === "conflict") {
      return result({
        action,
        approval,
        status: "conflict",
        requestAttempted,
        receiptState: "request_started",
        currentDeploymentId: observation.currentDeploymentId,
        retryable: true,
        nextStep:
          "Inspect the Vercel project and production-domain routing before creating a new approval.",
        message:
          "Production domains are split or point to a deployment outside this approval.",
      })
    }
    if (attempt + 1 < RECONCILIATION_ATTEMPTS) {
      await dependencies.sleep(RECONCILIATION_DELAY_MS)
    }
  }
  return result({
    action,
    approval,
    status: "ambiguous",
    requestAttempted,
    receiptState: "request_started",
    currentDeploymentId: observation?.currentDeploymentId ?? null,
    retryable: true,
    nextStep:
      "Inspect Vercel, then check this same approval again. The Worker will reconcile without repeating the request.",
    message:
      "The request boundary is recorded, but production has not been confirmed on the approved deployment.",
  })
}

async function handleExistingReceipt(
  action: TransitionAction,
  approval: ApprovalSnapshot,
  config: WorkerConfig,
  dependencies: TransitionDependencies
): Promise<TransitionResult> {
  if (
    approval.receipt?.state === "rejected" ||
    approval.receipt?.state === "cancelled"
  ) {
    const cancelled = approval.receipt.state === "cancelled"
    return result({
      action,
      approval,
      status: "blocked",
      receiptState: approval.receipt.state,
      nextStep:
        "Resolve the reported provider state and create a new approval page before trying again.",
      message: cancelled
        ? "The final provider guard changed, so this approval was cancelled before any request."
        : "Vercel definitely rejected the request recorded for this approval.",
    })
  }
  const observation = await dependencies.vercel.observeProduction(
    config.teamId,
    config.projectId,
    config.productionDomains
  )
  const state = routingState(observation, approval)
  if (approval.receipt?.state === "completed") {
    if (state !== "target") {
      return result({
        action,
        approval,
        status: "conflict",
        receiptState: "completed",
        currentDeploymentId: observation.currentDeploymentId,
        nextStep:
          "Production changed after this approval completed. Use a new approval for any new traffic change.",
        message:
          "The completed receipt is valid, but live production no longer uses its target deployment.",
      })
    }
    try {
      await dependencies.vercel.checkProductionHealth(
        config.productionDomains,
        config.healthPaths
      )
    } catch (error) {
      const code =
        error instanceof SafetyError ? error.code : "HEALTH_CHECK_FAILED"
      return result({
        action,
        approval,
        status: "blocked",
        receiptState: "completed",
        currentDeploymentId: approval.targetDeploymentId,
        retryable: true,
        nextStep:
          "Fix the production health check, then check this completed approval again; no traffic request will be sent.",
        message: `Production still uses the completed target, but its health checks failed (${code}).`,
      })
    }
    return result({
      action,
      approval,
      status: "no_op",
      receiptState: "completed",
      currentDeploymentId: approval.targetDeploymentId,
      message:
        "This approval already completed and live production still matches it.",
    })
  }
  return reconcile(action, approval, config, dependencies, false)
}

async function cancelBoundary(
  action: TransitionAction,
  approval: ApprovalSnapshot,
  config: WorkerConfig,
  dependencies: TransitionDependencies,
  status: "blocked" | "conflict",
  currentDeploymentId: string | null,
  code: string
): Promise<TransitionResult> {
  let receiptState: TransitionResult["receiptState"] = "request_started"
  try {
    await writeReceipt(dependencies.notion, {
      pageId: approval.pageId,
      parentId: config.approvalParentId,
      expectedAction: action,
      receipt: createReceipt(approval, "cancelled", dependencies.now()),
    })
    receiptState = "cancelled"
  } catch {
    // The request_started receipt still prevents this approval from posting.
  }
  return result({
    action,
    approval,
    status,
    requestAttempted: false,
    receiptState,
    currentDeploymentId,
    retryable: false,
    nextStep:
      "Resolve the provider-state change and create a new approval page; this approval will not send a request.",
    message: `The final provider guard changed (${code}); no Vercel request was attempted.`,
  })
}

export async function executeApprovedTransition(
  action: TransitionAction,
  input: TransitionInput,
  config: WorkerConfig,
  dependencies: TransitionDependencies
): Promise<TransitionResult> {
  let approval: ApprovalSnapshot | null = null
  let requestAttempted = false
  try {
    approval = await readApproval(dependencies.notion, {
      pageId: input.approvalPageId,
      parentId: config.approvalParentId,
      expectedAction: action,
    })
    assertConfiguredApproval(approval, config)
    if (approval.receipt) {
      return await handleExistingReceipt(action, approval, config, dependencies)
    }

    const first = await verifyPreconditions(
      action,
      approval,
      config,
      dependencies
    )
    if (first.state === "target") {
      await dependencies.vercel.checkProductionHealth(
        config.productionDomains,
        config.healthPaths
      )
      return completeReceipt(action, approval, config, dependencies, false)
    }
    if (first.state === "conflict") {
      throw new SafetyError(
        "PRODUCTION_CONFLICT",
        "Production does not match the expected current deployment."
      )
    }

    const fresh = await readApproval(dependencies.notion, {
      pageId: input.approvalPageId,
      parentId: config.approvalParentId,
      expectedAction: action,
    })
    if (!sameApproval(approval, fresh) || fresh.receipt) {
      throw new SafetyError(
        "APPROVAL_CHANGED",
        "The approval changed during preflight. Review it before trying again."
      )
    }
    approval = fresh
    const final = await verifyPreconditions(
      action,
      approval,
      config,
      dependencies
    )
    if (final.state === "target") {
      await dependencies.vercel.checkProductionHealth(
        config.productionDomains,
        config.healthPaths
      )
      return completeReceipt(action, approval, config, dependencies, false)
    }
    if (final.state === "conflict") {
      throw new SafetyError(
        "PRODUCTION_CHANGED",
        "Production changed during preflight; no request was sent."
      )
    }

    const boundaryReceipt = createReceipt(
      approval,
      "request_started",
      dependencies.now()
    )
    await writeReceipt(dependencies.notion, {
      pageId: approval.pageId,
      parentId: config.approvalParentId,
      expectedAction: action,
      receipt: boundaryReceipt,
    })
    const fencedApproval = await readApproval(dependencies.notion, {
      pageId: approval.pageId,
      parentId: config.approvalParentId,
      expectedAction: action,
    })
    const boundaryMatches =
      sameApproval(approval, fencedApproval) &&
      fencedApproval.receipt !== null &&
      canonicalReceiptJson(fencedApproval.receipt) ===
        canonicalReceiptJson(boundaryReceipt)
    approval = fencedApproval
    if (!boundaryMatches) {
      throw new SafetyError(
        "RECEIPT_BOUNDARY_CHANGED",
        "The approval or request boundary changed before the Vercel request."
      )
    }
    let finalObservation: ProductionObservation
    try {
      ;[finalObservation] = await Promise.all([
        dependencies.vercel.observeProduction(
          config.teamId,
          config.projectId,
          config.productionDomains
        ),
        dependencies.vercel.assertRollingReleasesDisabled(
          config.teamId,
          config.projectId
        ),
      ])
    } catch (error) {
      const code =
        error instanceof SafetyError
          ? error.code
          : error instanceof VercelHttpError
            ? `VERCEL_${error.status ?? "READ_FAILED"}`
            : "FINAL_GUARD_FAILED"
      return cancelBoundary(
        action,
        approval,
        config,
        dependencies,
        "blocked",
        null,
        code
      )
    }
    const finalState = routingState(finalObservation, approval)
    if (finalState === "target") {
      await dependencies.vercel.checkProductionHealth(
        config.productionDomains,
        config.healthPaths
      )
      return completeReceipt(action, approval, config, dependencies, false)
    }
    if (finalState === "conflict") {
      return cancelBoundary(
        action,
        approval,
        config,
        dependencies,
        "conflict",
        finalObservation.currentDeploymentId,
        "PRODUCTION_CHANGED"
      )
    }

    requestAttempted = true
    try {
      await dependencies.vercel.requestTransition(
        action,
        config.teamId,
        config.projectId,
        approval.targetDeploymentId
      )
    } catch (error) {
      if (error instanceof VercelHttpError && !error.ambiguous) {
        await writeReceipt(dependencies.notion, {
          pageId: approval.pageId,
          parentId: config.approvalParentId,
          expectedAction: action,
          receipt: createReceipt(approval, "rejected", dependencies.now()),
        })
        return result({
          action,
          approval,
          status: "blocked",
          requestAttempted: true,
          receiptState: "rejected",
          nextStep: "Fix the Vercel rejection and create a new approval page.",
          message: `Vercel definitely rejected the request with HTTP ${error.status}.`,
        })
      }
      if (!(error instanceof VercelHttpError)) throw error
    }
    return await reconcile(action, approval, config, dependencies, true)
  } catch (error) {
    const code =
      error instanceof SafetyError ? error.code : "UNEXPECTED_FAILURE"
    const message =
      error instanceof SafetyError || error instanceof VercelHttpError
        ? error.message
        : "The approved transition failed closed."
    return result({
      action,
      approval,
      status:
        requestAttempted || approval?.receipt?.state === "request_started"
          ? "ambiguous"
          : code === "PRODUCTION_CONFLICT" ||
              code === "PRODUCTION_CHANGED" ||
              code.startsWith("PROJECT_ALIAS_SET_")
            ? "conflict"
            : "blocked",
      requestAttempted,
      receiptState: approval?.receipt?.state ?? "none",
      currentDeploymentId: null,
      retryable:
        approval?.receipt == null ||
        approval.receipt.state === "request_started",
      nextStep:
        requestAttempted || approval?.receipt?.state === "request_started"
          ? "Inspect Vercel, then check this same approval again; the Worker will not repeat the request."
          : approval?.receipt == null
            ? "Correct the approval or provider state, then check the page again."
            : "Inspect Vercel and reconcile this approval before any new traffic request.",
      message: `${code}: ${message}`,
    })
  }
}
