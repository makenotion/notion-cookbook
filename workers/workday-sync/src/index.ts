// Workday org chart — a privacy-minimal directory of active employees,
// supervisory organizations (called Teams in Notion), and manager relations.
//
// Workday remains authoritative. Both databases are complete replace-mode
// snapshots: fixed as-of values keep every WWS page consistent, and Notion
// only sweeps stale rows after the final page succeeds.

import { Worker } from "@notionhq/workers"

import {
  INITIAL_TITLE as PEOPLE_TITLE,
  PRIMARY_KEY as PEOPLE_PRIMARY_KEY,
  peopleSchema,
} from "./people.js"
import {
  runPeopleSyncPage,
  runTeamsSyncPage,
  type DirectorySyncState,
  type WorkdayDirectoryClient,
} from "./sync.js"
import {
  INITIAL_TITLE as TEAMS_TITLE,
  PRIMARY_KEY as TEAMS_PRIMARY_KEY,
  teamSchema,
} from "./teams.js"
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

const teams = worker.database("teams", {
  type: "managed",
  initialTitle: TEAMS_TITLE,
  primaryKeyProperty: TEAMS_PRIMARY_KEY,
  schema: teamSchema,
})

const people = worker.database("people", {
  type: "managed",
  initialTitle: PEOPLE_TITLE,
  primaryKeyProperty: PEOPLE_PRIMARY_KEY,
  schema: peopleSchema,
})

// Register teams first so the recommended initial manual trigger order creates
// Team relation targets before People rows reference them.
worker.sync("teamsSync", {
  database: teams,
  mode: "replace",
  schedule: "1h",
  execute: (state: DirectorySyncState | undefined) =>
    runTeamsSyncPage(workdayClient(), state),
})

worker.sync("peopleSync", {
  database: people,
  mode: "replace",
  schedule: "1h",
  execute: (state: DirectorySyncState | undefined) =>
    runPeopleSyncPage(workdayClient(), state),
})

export default worker
