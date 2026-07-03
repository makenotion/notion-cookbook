// Authenticated GitHub stars become a current, filterable Notion research
// library. A full hourly replacement is deliberate: GitHub has no unstar feed,
// and replacement removes repositories only after two membership scans agree.

import { Worker } from "@notionhq/workers"

import {
  createGitHubAccessTokenProvider,
  getExpectedGitHubUserId,
} from "./auth.js"
import { createGitHubStarsClient } from "./github.js"
import { INITIAL_TITLE, PRIMARY_KEY, repositorySchema } from "./repositories.js"
import { runStarsSyncPage, type StarsSyncState } from "./sync.js"

const worker = new Worker()

// Authenticated REST requests normally receive a 5,000-request hourly budget.
// Leave headroom for other activity associated with the same user credential.
const pacer = worker.pacer("github", {
  allowedRequests: 4_800,
  intervalMs: 3_600_000,
})

const github = createGitHubStarsClient({
  beforeRequest: () => pacer.wait(),
  getAccessToken: createGitHubAccessTokenProvider(worker),
  getExpectedUserId: () => getExpectedGitHubUserId(),
})

const starredRepositories = worker.database("starredRepositories", {
  type: "managed",
  initialTitle: INITIAL_TITLE,
  primaryKeyProperty: PRIMARY_KEY,
  schema: repositorySchema,
})

worker.sync("starredRepositoriesSync", {
  database: starredRepositories,
  mode: "replace",
  schedule: "1h",
  execute: (state: StarsSyncState | undefined) =>
    runStarsSyncPage(github, state),
})

export default worker
