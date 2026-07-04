import assert from "node:assert/strict"
import test from "node:test"

import { ConfigError, loadConfig } from "../src/config.js"

function env(): NodeJS.ProcessEnv {
  return {
    SENTRY_AUTH_TOKEN: "sentry-token",
    SENTRY_ORG_SLUG: "acme",
    SENTRY_PROJECT_SLUG: "checkout-api",
    SENTRY_ENVIRONMENT: "production",
    PAGERDUTY_API_TOKEN: "pagerduty-token",
    PAGERDUTY_FROM_EMAIL: "incident-bot@example.com",
    PAGERDUTY_SERVICE_ID: "service_7f3c2a",
    PAGERDUTY_PRIORITY_IDS_JSON: JSON.stringify({
      sev1: "priority-critical",
      sev2: "priority-high",
      sev3: "priority-medium",
    }),
  }
}

test("configuration treats PagerDuty IDs as opaque and fixes provider scope", () => {
  const config = loadConfig(env())
  assert.equal(config.sentryOrgSlug, "acme")
  assert.equal(config.sentryProjectSlug, "checkout-api")
  assert.equal(config.sentryEnvironment, "production")
  assert.equal(config.pagerDutyServiceId, "service_7f3c2a")
  assert.equal(config.pagerDutyPriorityIds.sev1, "priority-critical")
  assert.equal(config.pagerDutyBaseUrl, "https://api.pagerduty.com")
  assert.equal(config.requestTimeoutMs, 8_000)
})

test("configuration supports self-hosted Sentry and PagerDuty EU", () => {
  const values = env()
  values.SENTRY_BASE_URL = "https://sentry.example.com"
  values.PAGERDUTY_REGION = "eu"
  const config = loadConfig(values)
  assert.equal(config.sentryBaseUrl, "https://sentry.example.com")
  assert.equal(config.pagerDutyBaseUrl, "https://api.eu.pagerduty.com")
})

test("configuration requires an exact three-level priority map", () => {
  const values = env()
  values.PAGERDUTY_PRIORITY_IDS_JSON = JSON.stringify({
    sev1: "same",
    sev2: "same",
    sev3: "other",
  })
  assert.throws(
    () => loadConfig(values),
    (error: unknown) =>
      error instanceof ConfigError && /must be unique/.test(error.message)
  )
})

test("configuration loads only when a tool executes", async () => {
  const saved = process.env.SENTRY_AUTH_TOKEN
  delete process.env.SENTRY_AUTH_TOKEN
  try {
    const module = await import("../src/index.js")
    assert.ok(module.default)
  } finally {
    if (saved === undefined) delete process.env.SENTRY_AUTH_TOKEN
    else process.env.SENTRY_AUTH_TOKEN = saved
  }
})
