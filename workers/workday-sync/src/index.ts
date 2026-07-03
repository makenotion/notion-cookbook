// Workday employee directory — active employees, supervisory organizations,
// optional work email/profile identity, and supervisory manager relations.
//
// Both databases are complete daily snapshots built from Workday. Fixed as-of
// values keep every WWS page consistent, and Notion only sweeps stale rows
// after the final page succeeds.

import { Worker } from "@notionhq/workers"

import {
  INITIAL_TITLE as PEOPLE_TITLE,
  PRIMARY_KEY as PEOPLE_PRIMARY_KEY,
  peopleSchema,
} from "./people.js"
import {
  runOrganizationsSyncPage,
  runPeopleSyncPage,
  type DirectorySyncState,
  type WorkdayDirectoryClient,
} from "./sync.js"
import {
  INITIAL_TITLE as ORGANIZATIONS_TITLE,
  PRIMARY_KEY as ORGANIZATIONS_PRIMARY_KEY,
  organizationSchema,
} from "./organizations.js"
import {
  createWorkdayClient,
  createWorkdayTokenProvider,
  getWorkdayConfig,
} from "./workday.js"

const worker = new Worker()

// Workday applies dynamic tenant-level throttling rather than one universal
// public quota. Keep both snapshots behind one conservative request budget;
// HTTP overload signals are also surfaced as Workers RateLimitError values.
const pacer = worker.pacer("workday", {
  allowedRequests: 4,
  intervalMs: 1_000,
})
const beforeWorkdayRequest = () => pacer.wait()

let client: WorkdayDirectoryClient | undefined

function workdayClient() {
  return (client ??= (() => {
    const config = getWorkdayConfig()
    const tokenProvider = createWorkdayTokenProvider(
      config,
      beforeWorkdayRequest
    )
    return createWorkdayClient(config, tokenProvider, beforeWorkdayRequest)
  })())
}

const organizations = worker.database("organizations", {
  type: "managed",
  initialTitle: ORGANIZATIONS_TITLE,
  primaryKeyProperty: ORGANIZATIONS_PRIMARY_KEY,
  schema: organizationSchema,
})

const people = worker.database("people", {
  type: "managed",
  initialTitle: PEOPLE_TITLE,
  primaryKeyProperty: PEOPLE_PRIMARY_KEY,
  schema: peopleSchema,
})

// Register organizations first so the recommended initial manual trigger order
// creates relation targets before People rows reference them.
worker.sync("organizationsSync", {
  database: organizations,
  mode: "replace",
  schedule: "1d",
  execute: (state: DirectorySyncState | undefined) =>
    runOrganizationsSyncPage(workdayClient(), state),
})

worker.sync("peopleSync", {
  database: people,
  mode: "replace",
  schedule: "1d",
  execute: (state: DirectorySyncState | undefined) =>
    runPeopleSyncPage(workdayClient(), state),
})

export default worker
