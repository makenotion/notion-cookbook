import { DEPLOYMENT_ID, GIT_SHA, MAX_HEALTH_DOMAINS } from "./config.js"
import type {
  InspectInput,
  InspectionResult,
  ProductionObservation,
  RollingReleaseState,
  TransitionAction,
  TransitionDependencies,
  TransitionInput,
  TransitionResult,
  VercelDeployment,
  WorkerConfig,
} from "./types.js"
import { SafetyError, VercelHttpError } from "./types.js"

// Production release inspection, safety checks, mutations, and reconciliation.
const RECONCILIATION_ATTEMPTS = 6
const RECONCILIATION_DELAY_MS = 1_000
const ROLLBACK_WARNING =
  "Instant Rollback reuses a previous build, so environment variables and cron configuration may be stale. Vercel pauses automatic Production-domain assignment until a later promotion."

type DeploymentChecks = InspectionResult["deploymentChecks"]

interface LiveState {
  target: VercelDeployment
  production: ProductionObservation
  rollingRelease: RollingReleaseState
  deploymentChecks: DeploymentChecks
}

function transitionNeeded(action: TransitionAction, state: LiveState): boolean {
  return (
    state.production.currentDeploymentId !== state.target.id ||
    (action === "rollback" && state.rollingRelease === "active")
  )
}

function deploymentCheckResult(target: VercelDeployment): DeploymentChecks {
  if (target.checksState === null && target.checksConclusion === null) {
    return "not_reported"
  }
  return target.checksState === "completed" &&
    target.checksConclusion === "succeeded"
    ? "passed"
    : "blocked"
}

function validateIds(input: {
  targetDeploymentId: string
  expectedCurrentDeploymentId?: string
  expectedGitSha?: string | null
}): void {
  if (!DEPLOYMENT_ID.test(input.targetDeploymentId)) {
    throw new SafetyError(
      "INVALID_TARGET_DEPLOYMENT",
      "targetDeploymentId must be a Vercel dpl_ identifier."
    )
  }
  if (
    input.expectedCurrentDeploymentId !== undefined &&
    !DEPLOYMENT_ID.test(input.expectedCurrentDeploymentId)
  ) {
    throw new SafetyError(
      "INVALID_CURRENT_DEPLOYMENT",
      "expectedCurrentDeploymentId must be a Vercel dpl_ identifier."
    )
  }
  if (
    input.expectedGitSha !== undefined &&
    input.expectedGitSha !== null &&
    !GIT_SHA.test(input.expectedGitSha)
  ) {
    throw new SafetyError(
      "INVALID_GIT_SHA",
      "expectedGitSha must be a full lowercase Git SHA or null."
    )
  }
}

async function readLiveState(
  targetDeploymentId: string,
  config: WorkerConfig,
  dependencies: TransitionDependencies
): Promise<LiveState> {
  const [target, production, rollingRelease] = await Promise.all([
    dependencies.vercel.getDeployment(
      config.teamId,
      config.projectId,
      targetDeploymentId
    ),
    dependencies.vercel.observeProduction(config.teamId, config.projectId),
    dependencies.vercel.getRollingReleaseState(config.teamId, config.projectId),
  ])
  return {
    target,
    production,
    rollingRelease,
    deploymentChecks: deploymentCheckResult(target),
  }
}

function validateLiveState(
  action: TransitionAction,
  state: LiveState,
  config: WorkerConfig,
  expectedGitSha: string | null = null
): void {
  if (
    state.target.target !== "production" ||
    state.target.readyState !== "READY"
  ) {
    throw new SafetyError(
      "TARGET_NOT_READY",
      "The target must be a READY Production deployment."
    )
  }
  if (expectedGitSha !== null && state.target.gitSha !== expectedGitSha) {
    throw new SafetyError(
      "TARGET_GIT_SHA_CHANGED",
      "The target Git SHA differs from the inspected deployment."
    )
  }
  if (state.production.currentDeploymentId === null) {
    throw new SafetyError(
      "PRODUCTION_SPLIT",
      "Production domains do not currently point to one deployment."
    )
  }
  if (
    config.healthPaths.length > 0 &&
    state.production.productionDomains.length > MAX_HEALTH_DOMAINS
  ) {
    throw new SafetyError(
      "HEALTH_FANOUT_UNSUPPORTED",
      `Optional health checks support up to ${MAX_HEALTH_DOMAINS} direct Production domains.`
    )
  }

  if (!transitionNeeded(action, state)) return

  if (action === "promote") {
    if (state.rollingRelease !== "none") {
      throw new SafetyError(
        "ROLLING_RELEASE_UNSUPPORTED",
        "This basic promotion tool does not manage Vercel Rolling Releases."
      )
    }
    if (state.target.readySubstate !== "STAGED") {
      throw new SafetyError(
        "TARGET_NOT_STAGED",
        "Promotion requires a READY/STAGED Production deployment."
      )
    }
    if (state.deploymentChecks === "blocked") {
      throw new SafetyError(
        "DEPLOYMENT_CHECKS_BLOCKED",
        "The target's Vercel Deployment Checks have not succeeded."
      )
    }
  } else if (state.target.readySubstate !== "PROMOTED") {
    throw new SafetyError(
      "TARGET_NOT_ROLLBACK_ELIGIBLE",
      "Rollback requires a deployment that previously served Production."
    )
  }
}

function inspection(
  input: InspectInput,
  state: LiveState | null,
  options: {
    status: InspectionResult["status"]
    ok: boolean
    message: string
  }
): InspectionResult {
  return {
    ok: options.ok,
    status: options.status,
    action: input.action,
    targetDeploymentId: DEPLOYMENT_ID.test(input.targetDeploymentId)
      ? input.targetDeploymentId
      : "invalid",
    targetUrl: state?.target.url ?? null,
    expectedGitSha: state?.target.gitSha ?? null,
    targetReadySubstate: state?.target.readySubstate ?? null,
    expectedCurrentDeploymentId: state?.production.currentDeploymentId ?? null,
    productionDomains: state?.production.productionDomains ?? [],
    deploymentChecks: state?.deploymentChecks ?? "not_reported",
    warning:
      input.action === "rollback"
        ? `${ROLLBACK_WARNING}${state?.rollingRelease === "active" ? " This rollback will also stop the active Rolling Release." : ""}`
        : null,
    message: options.message,
  }
}

export async function inspectProductionChange(
  input: InspectInput,
  config: WorkerConfig,
  dependencies: TransitionDependencies
): Promise<InspectionResult> {
  let state: LiveState | null = null
  try {
    validateIds(input)
    state = await readLiveState(input.targetDeploymentId, config, dependencies)
    validateLiveState(input.action, state, config)
    if (!transitionNeeded(input.action, state)) {
      await dependencies.vercel.checkProductionHealth(
        state.production.productionDomains,
        config.healthPaths
      )
      return inspection(input, state, {
        ok: true,
        status: "already_live",
        message: "The target already serves every Production domain.",
      })
    }
    await dependencies.vercel.checkDeploymentHealth(
      state.target.url,
      config.healthPaths
    )
    return inspection(input, state, {
      ok: true,
      status: "ready",
      message:
        input.action === "promote"
          ? "The staged Production deployment is ready to promote."
          : "The previous Production deployment is eligible for Instant Rollback.",
    })
  } catch (error) {
    const code =
      error instanceof SafetyError ? error.code : "VERCEL_READ_FAILED"
    const message =
      error instanceof SafetyError || error instanceof VercelHttpError
        ? error.message
        : "The Vercel release state could not be inspected."
    return inspection(input, state, {
      ok: false,
      status:
        code === "PRODUCTION_SPLIT" || code === "TARGET_GIT_SHA_CHANGED"
          ? "conflict"
          : "blocked",
      message: `${code}: ${message}`,
    })
  }
}

function transitionResult(
  action: TransitionAction,
  input: TransitionInput,
  options: {
    status: TransitionResult["status"]
    currentDeploymentId?: string | null
    requestAttempted?: boolean
    nextStep?: string | null
    message: string
  }
): TransitionResult {
  return {
    ok: options.status === "completed" || options.status === "no_op",
    status: options.status,
    action,
    targetDeploymentId: DEPLOYMENT_ID.test(input.targetDeploymentId)
      ? input.targetDeploymentId
      : "invalid",
    currentDeploymentId: options.currentDeploymentId ?? null,
    requestAttempted: options.requestAttempted ?? false,
    nextStep: options.nextStep ?? null,
    message: options.message,
  }
}

async function targetAlreadyLive(
  action: TransitionAction,
  input: TransitionInput,
  production: ProductionObservation,
  config: WorkerConfig,
  dependencies: TransitionDependencies,
  requestAttempted: boolean
): Promise<TransitionResult> {
  try {
    await dependencies.vercel.checkProductionHealth(
      production.productionDomains,
      config.healthPaths
    )
  } catch (error) {
    const code =
      error instanceof SafetyError ? error.code : "HEALTH_CHECK_FAILED"
    return transitionResult(action, input, {
      status: "unhealthy",
      currentDeploymentId: input.targetDeploymentId,
      requestAttempted,
      nextStep:
        "Production moved to the target, but its configured health checks need attention.",
      message: `The target serves Production, but a health check failed (${code}).`,
    })
  }
  return transitionResult(action, input, {
    status: requestAttempted ? "completed" : "no_op",
    currentDeploymentId: input.targetDeploymentId,
    requestAttempted,
    message: requestAttempted
      ? `Vercel ${action === "promote" ? "promotion" : "rollback"} completed.`
      : "The target already serves every Production domain; no request was sent.",
  })
}

function transitionInProgress(
  observation: ProductionObservation,
  expectedCurrentDeploymentId: string,
  targetDeploymentId: string
): boolean {
  const ids = Object.values(observation.domainDeploymentIds)
  return (
    ids.length > 0 &&
    ids.every(
      (id) => id === expectedCurrentDeploymentId || id === targetDeploymentId
    )
  )
}

async function reconcile(
  action: TransitionAction,
  input: TransitionInput,
  config: WorkerConfig,
  dependencies: TransitionDependencies,
  waitForRollingReleaseAbort: boolean
): Promise<TransitionResult> {
  let lastObservation: ProductionObservation | null = null
  for (let attempt = 0; attempt < RECONCILIATION_ATTEMPTS; attempt++) {
    try {
      lastObservation = await dependencies.vercel.observeProduction(
        config.teamId,
        config.projectId
      )
    } catch {
      break
    }
    let rollingReleaseActive = false
    if (
      waitForRollingReleaseAbort &&
      lastObservation.currentDeploymentId === input.targetDeploymentId
    ) {
      try {
        rollingReleaseActive =
          (await dependencies.vercel.getRollingReleaseState(
            config.teamId,
            config.projectId
          )) === "active"
      } catch {
        break
      }
    }
    if (
      lastObservation.currentDeploymentId === input.targetDeploymentId &&
      !rollingReleaseActive
    ) {
      return targetAlreadyLive(
        action,
        input,
        lastObservation,
        config,
        dependencies,
        true
      )
    }
    if (
      lastObservation.currentDeploymentId !==
        input.expectedCurrentDeploymentId &&
      !transitionInProgress(
        lastObservation,
        input.expectedCurrentDeploymentId,
        input.targetDeploymentId
      )
    ) {
      return transitionResult(action, input, {
        status: "conflict",
        currentDeploymentId: lastObservation.currentDeploymentId,
        requestAttempted: true,
        nextStep:
          "Inspect the Vercel project before another production change.",
        message:
          "Production moved to a deployment outside this requested transition.",
      })
    }
    if (attempt + 1 < RECONCILIATION_ATTEMPTS) {
      await dependencies.sleep(RECONCILIATION_DELAY_MS)
    }
  }
  return transitionResult(action, input, {
    status: "ambiguous",
    currentDeploymentId: lastObservation?.currentDeploymentId ?? null,
    requestAttempted: true,
    nextStep:
      "Run inspectProductionChange to check live Vercel state. Do not repeat the write tool until the result is clear.",
    message:
      "Vercel accepted or may have received the request, but the target was not confirmed in Production.",
  })
}

export async function executeTransition(
  action: TransitionAction,
  input: TransitionInput,
  config: WorkerConfig,
  dependencies: TransitionDependencies
): Promise<TransitionResult> {
  let requestAttempted = false
  try {
    validateIds(input)
    const first = await readLiveState(
      input.targetDeploymentId,
      config,
      dependencies
    )
    validateLiveState(action, first, config, input.expectedGitSha)
    if (!transitionNeeded(action, first)) {
      return targetAlreadyLive(
        action,
        input,
        first.production,
        config,
        dependencies,
        false
      )
    }
    if (
      first.production.currentDeploymentId !== input.expectedCurrentDeploymentId
    ) {
      throw new SafetyError(
        "EXPECTED_CURRENT_CHANGED",
        "Production no longer matches expectedCurrentDeploymentId."
      )
    }
    await dependencies.vercel.checkDeploymentHealth(
      first.target.url,
      config.healthPaths
    )

    const final = await readLiveState(
      input.targetDeploymentId,
      config,
      dependencies
    )
    validateLiveState(action, final, config, input.expectedGitSha)
    if (!transitionNeeded(action, final)) {
      return targetAlreadyLive(
        action,
        input,
        final.production,
        config,
        dependencies,
        false
      )
    }
    if (
      final.production.currentDeploymentId !== input.expectedCurrentDeploymentId
    ) {
      throw new SafetyError(
        "EXPECTED_CURRENT_CHANGED",
        "Production changed during preflight; no request was sent."
      )
    }

    requestAttempted = true
    try {
      await dependencies.vercel.requestTransition(
        action,
        config.teamId,
        config.projectId,
        input.targetDeploymentId
      )
    } catch (error) {
      if (error instanceof VercelHttpError && !error.ambiguous) {
        return transitionResult(action, input, {
          status: "blocked",
          currentDeploymentId: final.production.currentDeploymentId,
          requestAttempted: true,
          nextStep:
            "Resolve the Vercel rejection, then inspect live state again.",
          message: `Vercel rejected the ${action} request with HTTP ${error.status}.`,
        })
      }
      if (!(error instanceof VercelHttpError)) throw error
    }
    return await reconcile(
      action,
      input,
      config,
      dependencies,
      action === "rollback" && final.rollingRelease === "active"
    )
  } catch (error) {
    const code =
      error instanceof SafetyError ? error.code : "VERCEL_READ_FAILED"
    const message =
      error instanceof SafetyError || error instanceof VercelHttpError
        ? error.message
        : "The Vercel production change failed closed."
    return transitionResult(action, input, {
      status:
        code === "EXPECTED_CURRENT_CHANGED" ||
        code === "PRODUCTION_SPLIT" ||
        code === "TARGET_GIT_SHA_CHANGED"
          ? "conflict"
          : requestAttempted
            ? "ambiguous"
            : "blocked",
      requestAttempted,
      nextStep: requestAttempted
        ? "Inspect live Vercel state before another write request."
        : "Correct the target or Vercel state, then inspect the change again.",
      message: `${code}: ${message}`,
    })
  }
}
