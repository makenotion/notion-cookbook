import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"
import { loadConfig } from "./config.js"
import { executeTransition, inspectProductionChange } from "./release.js"
import type {
  InspectInput,
  TransitionAction,
  TransitionInput,
} from "./types.js"
import { VercelClient } from "./vercel.js"

const worker = new Worker()
export default worker

const inspectionInput = j.object({
  action: j
    .enum("promote", "rollback")
    .describe("Production change to inspect."),
  targetDeploymentId: j
    .string()
    .describe("Exact Vercel dpl_ deployment ID to inspect."),
})

const inspectionOutput = j.object({
  ok: j.boolean().describe("Whether the change is ready or already complete."),
  status: j
    .enum("ready", "already_live", "blocked", "conflict")
    .describe("Current eligibility of the requested production change."),
  action: j.enum("promote", "rollback").describe("Inspected action."),
  targetDeploymentId: j.string().describe("Canonical target deployment ID."),
  targetUrl: j.string().nullable().describe("Target deployment hostname."),
  expectedGitSha: j
    .string()
    .nullable()
    .describe("Git SHA to copy into the write tool, or null for non-Git."),
  targetReadySubstate: j
    .string()
    .nullable()
    .describe("Vercel READY substate for the target."),
  expectedCurrentDeploymentId: j
    .string()
    .nullable()
    .describe("Current Production ID to copy into the write tool."),
  productionDomains: j
    .array(j.string())
    .describe("Direct Production domains discovered from Vercel."),
  deploymentChecks: j
    .enum("not_reported", "passed", "blocked")
    .describe("Aggregate Vercel Deployment Check result."),
  warning: j
    .string()
    .nullable()
    .describe("Vercel-specific consequence to show before confirmation."),
  message: j.string().describe("Concise inspection result."),
})

const transitionInput = j.object({
  targetDeploymentId: j
    .string()
    .describe("Exact target ID returned by inspectProductionChange."),
  expectedCurrentDeploymentId: j
    .string()
    .describe("Current Production ID returned by inspectProductionChange."),
  expectedGitSha: j
    .string()
    .nullable()
    .describe(
      "Git SHA returned by inspectProductionChange, or null for a non-Git deployment."
    ),
})

const transitionOutput = j.object({
  ok: j.boolean().describe("Whether the change completed safely."),
  status: j
    .enum("completed", "no_op", "blocked", "conflict", "ambiguous", "unhealthy")
    .describe("Observed outcome of the production change."),
  action: j.enum("promote", "rollback").describe("Requested action."),
  targetDeploymentId: j.string().describe("Requested target deployment."),
  currentDeploymentId: j
    .string()
    .nullable()
    .describe("Deployment last observed across Production domains."),
  requestAttempted: j
    .boolean()
    .describe("Whether this call sent a Vercel traffic request."),
  nextStep: j.string().nullable().describe("Required follow-up, if any."),
  message: j.string().describe("Concise result for the user."),
})

function createRuntime() {
  const config = loadConfig()
  const vercel = new VercelClient({
    token: config.vercelToken,
    protectionBypassSecret: config.protectionBypassSecret,
  })
  return {
    config,
    dependencies: {
      vercel,
      sleep: (milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    },
  }
}

worker.tool("inspectProductionChange", {
  title: "Inspect a Vercel Production change",
  description:
    "Inspect a staged Production promotion or Instant Rollback before requesting it. Use the returned target, current deployment, Git SHA, domains, checks, and warning when asking the user to confirm the write tool.",
  schema: inspectionInput,
  outputSchema: inspectionOutput,
  hints: { readOnlyHint: true },
  execute: (input) => {
    const { config, dependencies } = createRuntime()
    return inspectProductionChange(input as InspectInput, config, dependencies)
  },
})

function registerTransition(
  key: "promoteStagedProductionDeployment" | "rollbackProductionDeployment",
  action: TransitionAction,
  title: string,
  description: string
) {
  worker.tool(key, {
    title,
    description,
    schema: transitionInput,
    outputSchema: transitionOutput,
    hints: { readOnlyHint: false },
    execute: (input) => {
      const { config, dependencies } = createRuntime()
      return executeTransition(
        action,
        input as TransitionInput,
        config,
        dependencies
      )
    },
  })
}

registerTransition(
  "promoteStagedProductionDeployment",
  "promote",
  "Promote a staged Vercel Production deployment",
  "Promote a READY/STAGED Production deployment after inspectProductionChange and explicit user confirmation. The tool rechecks the fixed project, current deployment, Git SHA, Vercel Deployment Checks, Rolling Release state, and optional health endpoints before one request."
)

registerTransition(
  "rollbackProductionDeployment",
  "rollback",
  "Roll back a Vercel Production deployment",
  "Run Vercel Instant Rollback after inspectProductionChange and explicit user confirmation. The target must have served Production before. Rollback reuses the old build and pauses automatic Production-domain assignment until a later promotion."
)
