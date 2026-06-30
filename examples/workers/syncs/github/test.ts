// Offline tests for the github sync worker.
// No GitHub connection is made — API assertions use mocked fetch responses.
// Run: npm test  (or: npx tsx test.ts)

import {
  RateLimitError,
  type UserManagedOAuthConfiguration,
} from "@notionhq/workers"
import worker from "./src/index.js"
import {
  createGitHubAccessTokenProvider,
  GITHUB_OAUTH_CAPABILITY_KEY,
  getGitHubAuthMode,
} from "./src/auth.js"
import { issueToChange } from "./src/issues.js"
import { pullRequestToChange } from "./src/all-pull-requests.js"
import {
  openPullRequestToChange,
  reviewState,
  ciStatus,
} from "./src/open-pull-requests.js"
import { dateOnly } from "./src/helpers.js"
import { createGitHubClient, getRepos } from "./src/github.js"
import type {
  GitHubCombinedStatus,
  GitHubIssue,
  GitHubPullRequest,
  GitHubReview,
  GitHubCheckRun,
} from "./src/github.js"

let passed = 0
let failed = 0

function ok(name: string, cond: boolean) {
  if (cond) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}`)
  }
}

// ---------------------------------------------------------------------------
// issueToChange
// ---------------------------------------------------------------------------

console.log("issueToChange — standard issue:")

const REPO = "acme/widgets"

const standardIssue: GitHubIssue = {
  number: 42,
  title: "Button doesn't work on mobile",
  body: "Tapping the submit button on iOS does nothing.",
  state: "open",
  state_reason: null,
  user: { login: "alice" },
  assignees: [{ login: "bob" }, { login: "carol" }],
  labels: [{ name: "bug" }, { name: "mobile" }],
  milestone: { title: "v2.0" },
  comments: 5,
  reactions: { total_count: 3 },
  html_url: "https://github.com/acme/widgets/issues/42",
  created_at: "2024-06-15T10:30:00Z",
  updated_at: "2024-06-16T14:00:00Z",
  closed_at: null,
}

const issueChange = issueToChange(standardIssue, REPO)

ok("type is upsert", issueChange.type === "upsert")
ok("key includes repo and number", issueChange.key === "acme/widgets#42")
ok(
  "Title contains issue title",
  JSON.stringify(issueChange.properties.Title).includes("Button doesn't work")
)
ok(
  "Issue Key is repo#number",
  JSON.stringify(issueChange.properties["Issue Key"]).includes(
    "acme/widgets#42"
  )
)
ok(
  "Issue Link is html_url",
  JSON.stringify(issueChange.properties["Issue Link"]).includes(
    "https://github.com/acme/widgets/issues/42"
  )
)
ok(
  "State is Open",
  JSON.stringify(issueChange.properties.State).includes("Open")
)
ok(
  "Author is login",
  JSON.stringify(issueChange.properties.Author).includes("alice")
)
ok(
  "Assignees contains both logins",
  JSON.stringify(issueChange.properties.Assignees).includes("bob") &&
    JSON.stringify(issueChange.properties.Assignees).includes("carol")
)
ok(
  "Labels contains both labels",
  JSON.stringify(issueChange.properties.Labels).includes("bug") &&
    JSON.stringify(issueChange.properties.Labels).includes("mobile")
)
ok(
  "Milestone is set",
  JSON.stringify(issueChange.properties.Milestone).includes("v2.0")
)
ok(
  "Comments is 5",
  JSON.stringify(issueChange.properties.Comments).includes("5")
)
ok(
  "Reactions is 3",
  JSON.stringify(issueChange.properties.Reactions).includes("3")
)
ok(
  "Repository is repo",
  JSON.stringify(issueChange.properties.Repository).includes("acme/widgets")
)
ok(
  "pageContentMarkdown contains body",
  issueChange.pageContentMarkdown.includes("iOS")
)
ok("null closed_at omits Closed", issueChange.properties.Closed === undefined)

// ---------------------------------------------------------------------------
// issueToChange — closed issue with state reason
// ---------------------------------------------------------------------------

console.log("issueToChange — closed issue:")

const closedIssue: GitHubIssue = {
  ...standardIssue,
  state: "closed",
  state_reason: "completed",
  closed_at: "2024-06-20T09:00:00Z",
}

const closedChange = issueToChange(closedIssue, REPO)

ok(
  "State is Closed",
  JSON.stringify(closedChange.properties.State).includes("Closed")
)
ok(
  "State Reason is Completed",
  JSON.stringify(closedChange.properties["State Reason"]).includes("Completed")
)
ok(
  "Closed date is set",
  JSON.stringify(closedChange.properties.Closed).includes("2024-06-20")
)

// ---------------------------------------------------------------------------
// issueToChange — not_planned state reason
// ---------------------------------------------------------------------------

console.log("issueToChange — not planned:")

const notPlannedIssue: GitHubIssue = {
  ...standardIssue,
  state: "closed",
  state_reason: "not_planned",
  closed_at: "2024-06-20T09:00:00Z",
}

const notPlannedChange = issueToChange(notPlannedIssue, REPO)

ok(
  "State Reason maps not_planned to Not planned",
  JSON.stringify(notPlannedChange.properties["State Reason"]).includes(
    "Not planned"
  )
)

// ---------------------------------------------------------------------------
// issueToChange — minimal issue
// ---------------------------------------------------------------------------

console.log("issueToChange — minimal issue:")

const minimalIssue: GitHubIssue = {
  number: 1,
  title: "First issue",
  body: null,
  state: "open",
  state_reason: null,
  user: null,
  assignees: [],
  labels: [],
  milestone: null,
  comments: 0,
  reactions: { total_count: 0 },
  html_url: "https://github.com/acme/widgets/issues/1",
  created_at: "2024-01-01",
  updated_at: "2024-01-01",
  closed_at: null,
}

const minimalChange = issueToChange(minimalIssue, REPO)

ok("null user omits Author", minimalChange.properties.Author === undefined)
ok(
  "empty assignees omits Assignees",
  minimalChange.properties.Assignees === undefined
)
ok("empty labels omits Labels", minimalChange.properties.Labels === undefined)
ok(
  "null milestone omits Milestone",
  minimalChange.properties.Milestone === undefined
)
ok(
  "null state_reason omits State Reason",
  minimalChange.properties["State Reason"] === undefined
)
ok(
  "null body gives empty pageContentMarkdown",
  minimalChange.pageContentMarkdown === ""
)

// ---------------------------------------------------------------------------
// pullRequestToChange
// ---------------------------------------------------------------------------

console.log("pullRequestToChange — standard PR:")

const standardPR: GitHubPullRequest = {
  number: 123,
  title: "Add mobile support",
  body: "This PR adds responsive styles for mobile devices.",
  state: "open",
  draft: false,
  user: { login: "alice" },
  assignees: [{ login: "bob" }],
  requested_reviewers: [{ login: "carol" }, { login: "dave" }],
  labels: [{ name: "enhancement" }],
  milestone: { title: "v2.0" },
  base: { ref: "main" },
  head: { ref: "feature/mobile", sha: "abc123" },
  html_url: "https://github.com/acme/widgets/pull/123",
  closed_at: null,
  merged_at: null,
  created_at: "2024-06-15T10:30:00Z",
  updated_at: "2024-06-16T14:00:00Z",
}

const prChange = pullRequestToChange(standardPR, REPO)

ok("key includes repo and number", prChange.key === "acme/widgets#123")
ok(
  "PR Key is repo#number",
  JSON.stringify(prChange.properties["PR Key"]).includes("acme/widgets#123")
)
ok("State is Open", JSON.stringify(prChange.properties.State).includes("Open"))
ok("Draft is false", JSON.stringify(prChange.properties.Draft).includes("No"))
ok(
  "Reviewers contains both",
  JSON.stringify(prChange.properties.Reviewers).includes("carol") &&
    JSON.stringify(prChange.properties.Reviewers).includes("dave")
)
ok(
  "Base Branch is main",
  JSON.stringify(prChange.properties["Base Branch"]).includes("main")
)
ok(
  "Head Branch is feature/mobile",
  JSON.stringify(prChange.properties["Head Branch"]).includes("feature/mobile")
)
ok("null closed_at omits Closed", prChange.properties.Closed === undefined)
ok("null merged_at omits Merged", prChange.properties.Merged === undefined)

// ---------------------------------------------------------------------------
// pullRequestToChange — merged PR
// ---------------------------------------------------------------------------

console.log("pullRequestToChange — merged PR:")

const mergedPR: GitHubPullRequest = {
  ...standardPR,
  state: "closed",
  closed_at: "2024-06-17T12:00:00Z",
  merged_at: "2024-06-17T12:00:00Z",
}

const mergedChange = pullRequestToChange(mergedPR, REPO)

ok(
  "State is Merged when merged_at is set",
  JSON.stringify(mergedChange.properties.State).includes("Merged")
)
ok(
  "Closed date is set",
  JSON.stringify(mergedChange.properties.Closed).includes("2024-06-17")
)
ok(
  "Merged date is set",
  JSON.stringify(mergedChange.properties.Merged).includes("2024-06-17")
)
// ---------------------------------------------------------------------------
// pullRequestToChange — closed but not merged
// ---------------------------------------------------------------------------

console.log("pullRequestToChange — closed not merged:")

const closedPR: GitHubPullRequest = {
  ...standardPR,
  state: "closed",
  closed_at: "2024-06-18T09:00:00Z",
  merged_at: null,
}

const closedPRChange = pullRequestToChange(closedPR, REPO)

ok(
  "State is Closed when not merged",
  JSON.stringify(closedPRChange.properties.State).includes("Closed")
)
ok(
  "Closed date is set",
  JSON.stringify(closedPRChange.properties.Closed).includes("2024-06-18")
)
ok(
  "null merged_at omits Merged",
  closedPRChange.properties.Merged === undefined
)

// ---------------------------------------------------------------------------
// pullRequestToChange — minimal PR (all optional fields null/empty)
// ---------------------------------------------------------------------------

console.log("pullRequestToChange — minimal PR:")

const minimalPR: GitHubPullRequest = {
  number: 1,
  title: "First PR",
  body: null,
  state: "open",
  draft: false,
  user: null,
  assignees: [],
  requested_reviewers: [],
  labels: [],
  milestone: null,
  base: { ref: "main" },
  head: { ref: "fix", sha: "def456" },
  html_url: "https://github.com/acme/widgets/pull/1",
  closed_at: null,
  merged_at: null,
  created_at: "2024-01-01",
  updated_at: "2024-01-01",
}

const minimalPRChange = pullRequestToChange(minimalPR, REPO)

ok("null user omits Author", minimalPRChange.properties.Author === undefined)
ok(
  "empty assignees omits Assignees",
  minimalPRChange.properties.Assignees === undefined
)
ok(
  "empty reviewers omits Reviewers",
  minimalPRChange.properties.Reviewers === undefined
)
ok("empty labels omits Labels", minimalPRChange.properties.Labels === undefined)
ok(
  "null milestone omits Milestone",
  minimalPRChange.properties.Milestone === undefined
)
ok(
  "null body gives empty pageContentMarkdown",
  minimalPRChange.pageContentMarkdown === ""
)

// ---------------------------------------------------------------------------
// reviewState — aggregates review decisions
// ---------------------------------------------------------------------------

console.log("reviewState:")

ok("empty reviews returns undefined", reviewState([]) === undefined)

ok(
  "single approval",
  reviewState([
    { id: 1, state: "APPROVED", user: { login: "alice" }, submitted_at: null },
  ]) === "Approved"
)

ok(
  "changes requested wins over approval from different authors",
  reviewState([
    { id: 1, state: "APPROVED", user: { login: "alice" }, submitted_at: null },
    {
      id: 2,
      state: "CHANGES_REQUESTED",
      user: { login: "bob" },
      submitted_at: null,
    },
  ]) === "Changes Requested"
)

ok(
  "later approval from same author overrides changes requested",
  reviewState([
    {
      id: 1,
      state: "CHANGES_REQUESTED",
      user: { login: "alice" },
      submitted_at: null,
    },
    { id: 2, state: "APPROVED", user: { login: "alice" }, submitted_at: null },
  ]) === "Approved"
)

ok(
  "COMMENTED reviews are ignored",
  reviewState([
    { id: 1, state: "COMMENTED", user: { login: "alice" }, submitted_at: null },
  ]) === undefined
)

ok(
  "DISMISSED review removes that author's vote",
  reviewState([
    { id: 1, state: "APPROVED", user: { login: "alice" }, submitted_at: null },
    { id: 2, state: "DISMISSED", user: { login: "alice" }, submitted_at: null },
  ]) === undefined
)

// ---------------------------------------------------------------------------
// ciStatus — aggregates check run results
// ---------------------------------------------------------------------------

console.log("ciStatus:")

const NO_COMMIT_STATUSES: GitHubCombinedStatus = {
  state: "pending",
  total_count: 0,
}

ok(
  "no checks or commit statuses returns undefined",
  ciStatus([], NO_COMMIT_STATUSES) === undefined
)

ok(
  "all success",
  ciStatus(
    [
      { name: "lint", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "neutral" },
    ],
    NO_COMMIT_STATUSES
  ) === "Success"
)

ok(
  "any failure",
  ciStatus(
    [
      { name: "lint", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "timed_out" },
    ],
    NO_COMMIT_STATUSES
  ) === "Failure"
)

ok(
  "in-progress means pending",
  ciStatus(
    [
      { name: "lint", status: "completed", conclusion: "success" },
      { name: "test", status: "waiting", conclusion: null },
    ],
    NO_COMMIT_STATUSES
  ) === "Pending"
)

ok(
  "commit status failure is included",
  ciStatus([], { state: "failure", total_count: 2 }) === "Failure"
)

ok(
  "commit status success is included",
  ciStatus([], { state: "success", total_count: 2 }) === "Success"
)

// ---------------------------------------------------------------------------
// openPullRequestToChange — enriched open PR
// ---------------------------------------------------------------------------

console.log("openPullRequestToChange — with reviews and checks:")

const reviews: GitHubReview[] = [
  {
    id: 1,
    state: "APPROVED",
    user: { login: "carol" },
    submitted_at: "2024-06-16T12:00:00Z",
  },
]
const checks: GitHubCheckRun[] = [
  { name: "CI", status: "completed", conclusion: "success" },
]

const openChange = openPullRequestToChange(
  standardPR,
  REPO,
  reviews,
  checks,
  NO_COMMIT_STATUSES
)

ok(
  "Review Activity is Approved",
  JSON.stringify(openChange.properties["Review Activity"]).includes("Approved")
)
ok(
  "CI Status is Success",
  JSON.stringify(openChange.properties["CI Status"]).includes("Success")
)
ok(
  "PR Key is set",
  JSON.stringify(openChange.properties["PR Key"]).includes("acme/widgets#123")
)

console.log("openPullRequestToChange — no reviews or checks:")

const bareChange = openPullRequestToChange(
  standardPR,
  REPO,
  [],
  [],
  NO_COMMIT_STATUSES
)

ok(
  "no reviews omits Review Activity",
  bareChange.properties["Review Activity"] === undefined
)
ok(
  "no checks omits CI Status",
  bareChange.properties["CI Status"] === undefined
)
ok(
  "enriched change omits incomplete upstream timestamp",
  !("upstreamUpdatedAt" in openChange)
)

// ---------------------------------------------------------------------------
// dateOnly
// ---------------------------------------------------------------------------

console.log("dateOnly:")

ok(
  "ISO timestamp returns date part",
  dateOnly("2024-03-15T12:00:00Z") === "2024-03-15"
)
ok("plain date passes through", dateOnly("2024-03-15") === "2024-03-15")
ok("empty string returns empty", dateOnly("") === "")

// ---------------------------------------------------------------------------
// getRepos — parses GITHUB_REPOS env var
// ---------------------------------------------------------------------------

console.log("getRepos:")

const origRepos = process.env.GITHUB_REPOS

process.env.GITHUB_REPOS = "acme/widgets, acme/api , acme/docs"
const repos = getRepos()
ok("parses comma-separated repos", repos.length === 3)
ok("trims whitespace", repos[1] === "acme/api")

process.env.GITHUB_REPOS = "Acme/widgets,acme/WIDGETS,single/repo"
ok("deduplicates repos case-insensitively", getRepos().length === 2)

process.env.GITHUB_REPOS = ", ,"
let emptyReposThrew = false
try {
  getRepos()
} catch {
  emptyReposThrew = true
}
ok("rejects an empty parsed repo list", emptyReposThrew)

process.env.GITHUB_REPOS = "missing-slash"
let invalidRepoThrew = false
try {
  getRepos()
} catch {
  invalidRepoThrew = true
}
ok("rejects invalid owner/repo values", invalidRepoThrew)

delete process.env.GITHUB_REPOS
let threw = false
try {
  getRepos()
} catch {
  threw = true
}
ok("throws when GITHUB_REPOS not set", threw)

if (origRepos) process.env.GITHUB_REPOS = origRepos
else delete process.env.GITHUB_REPOS

// ---------------------------------------------------------------------------
// GitHub authentication modes
// ---------------------------------------------------------------------------

type OAuthRegistration = {
  key: string
  config: UserManagedOAuthConfiguration
}

function fakeOAuthWorker(accessToken = "github-user-token") {
  const registrations: OAuthRegistration[] = []
  return {
    registrations,
    worker: {
      oauth(key: string, config: UserManagedOAuthConfiguration) {
        registrations.push({ key, config })
        return { accessToken: async () => accessToken }
      },
    },
  }
}

async function runAuthTests() {
  console.log("GitHub authentication:")

  ok(
    "PAT remains the backwards-compatible default",
    getGitHubAuthMode({}) === "pat"
  )
  ok(
    "auth mode is normalized",
    getGitHubAuthMode({ GITHUB_AUTH_MODE: " Installation " }) === "installation"
  )

  let invalidModeThrew = false
  try {
    getGitHubAuthMode({ GITHUB_AUTH_MODE: "oauth-app" })
  } catch {
    invalidModeThrew = true
  }
  ok("rejects an unknown auth mode", invalidModeThrew)

  const patOAuth = fakeOAuthWorker()
  const patToken = createGitHubAccessTokenProvider(patOAuth.worker, {
    env: { GITHUB_AUTH_MODE: "pat", GITHUB_TOKEN: " github_pat_test " },
  })
  ok(
    "PAT mode returns the configured token",
    (await patToken(REPO)) === "github_pat_test"
  )
  ok(
    "OAuth is registered even before app credentials exist",
    patOAuth.registrations.length === 1 &&
      patOAuth.registrations[0].config.clientId === "" &&
      patOAuth.registrations[0].config.clientSecret === ""
  )

  const userOAuth = fakeOAuthWorker("github-user-token")
  const userToken = createGitHubAccessTokenProvider(userOAuth.worker, {
    env: {
      GITHUB_AUTH_MODE: "user",
      GITHUB_APP_CLIENT_ID: "Iv1.client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
    },
  })
  const userRegistration = userOAuth.registrations[0]
  ok(
    "user mode reads the Workers-managed OAuth token",
    (await userToken(REPO)) === "github-user-token"
  )
  ok(
    "user mode registers GitHub App OAuth without legacy scopes",
    userRegistration.key === GITHUB_OAUTH_CAPABILITY_KEY &&
      userRegistration.config.clientId === "Iv1.client-id" &&
      userRegistration.config.clientSecret === "client-secret" &&
      userRegistration.config.scope === "" &&
      userRegistration.config.authorizationEndpoint ===
        "https://github.com/login/oauth/authorize" &&
      userRegistration.config.tokenEndpoint ===
        "https://github.com/login/oauth/access_token"
  )

  const privateKey = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "test-key",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n")
  let installationOptions:
    { appId: string; privateKey: string; installationId: number } | undefined
  let installationFactoryCalls = 0
  let installationTokenRequests = 0
  const installationOAuth = fakeOAuthWorker()
  const installationToken = createGitHubAccessTokenProvider(
    installationOAuth.worker,
    {
      env: {
        GITHUB_AUTH_MODE: "installation",
        GITHUB_APP_CLIENT_ID: "Iv1.client-id",
        GITHUB_APP_PRIVATE_KEY_BASE64:
          Buffer.from(privateKey).toString("base64"),
        GITHUB_APP_INSTALLATION_ID: "123456",
      },
      createInstallationToken: (options) => {
        installationFactoryCalls++
        installationOptions = options
        return async () => {
          installationTokenRequests++
          return "github-installation-token"
        }
      },
    }
  )
  ok(
    "installation secrets stay lazy so the first deployment can succeed",
    installationOptions === undefined
  )
  const firstInstallationToken = await installationToken(REPO)
  const secondInstallationToken = await installationToken(REPO)
  ok(
    "installation mode returns app tokens from one reusable strategy",
    firstInstallationToken === "github-installation-token" &&
      secondInstallationToken === "github-installation-token" &&
      installationFactoryCalls === 1 &&
      installationTokenRequests === 2
  )
  ok(
    "installation mode decodes and validates its app configuration",
    installationOptions?.appId === "Iv1.client-id" &&
      installationOptions.privateKey === privateKey &&
      installationOptions.installationId === 123456
  )

  let invalidInstallationThrew = false
  try {
    const invalidInstallationToken = createGitHubAccessTokenProvider(
      fakeOAuthWorker().worker,
      {
        env: {
          GITHUB_AUTH_MODE: "installation",
          GITHUB_APP_CLIENT_ID: "Iv1.client-id",
          GITHUB_APP_PRIVATE_KEY_BASE64:
            Buffer.from(privateKey).toString("base64"),
          GITHUB_APP_INSTALLATION_ID: "not-an-id",
        },
      }
    )
    await invalidInstallationToken(REPO)
  } catch {
    invalidInstallationThrew = true
  }
  ok("rejects an invalid installation ID", invalidInstallationThrew)
}

// ---------------------------------------------------------------------------
// API client and Worker contracts — mocked HTTP only
// ---------------------------------------------------------------------------

type WorkerRunResult = {
  changes: Array<{ key: string }>
  hasMore: boolean
  nextUserContext?: { repoIndex: number; page: number }
}

function githubPacerContext() {
  return {
    pacers: {
      github: {
        lastScheduledAtMs: 0,
        allowedRequests: 1_000_000,
        intervalMs: 1,
      },
    },
  }
}

async function runApiClientTests() {
  console.log("API client and Worker contracts:")

  const syncCapabilities = worker.manifest.capabilities.filter(
    (capability) => capability._tag === "sync"
  )
  ok(
    "all sync schedules are the public 5-minute minimum",
    syncCapabilities.length === 3 &&
      syncCapabilities.every((capability) => {
        const schedule = (
          capability.config as {
            schedule?: { type: string; intervalMs?: number }
          }
        ).schedule
        return schedule?.type === "interval" && schedule.intervalMs === 300_000
      })
  )

  const oauthCapability = worker.manifest.capabilities.find(
    (capability) => capability._tag === "oauth"
  )
  ok(
    "the GitHub user OAuth capability is available before credentials exist",
    oauthCapability?.key === GITHUB_OAUTH_CAPABILITY_KEY &&
      (oauthCapability.config as { scope?: string }).scope === ""
  )

  const originalFetch = globalThis.fetch
  const originalToken = process.env.GITHUB_TOKEN
  const originalRepos = process.env.GITHUB_REPOS

  process.env.GITHUB_TOKEN = "github_pat_test"
  process.env.GITHUB_REPOS = REPO

  try {
    const requests: Request[] = []
    let waits = 0
    const tokenRepos: string[] = []
    const github = createGitHubClient({
      beforeRequest: async () => {
        waits++
      },
      getAccessToken: async (repo) => {
        tokenRepos.push(repo)
        return "github-provider-token"
      },
    })
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      return new Response(
        JSON.stringify([
          standardIssue,
          { ...standardIssue, number: 43, pull_request: { url: "pr" } },
        ]),
        {
          status: 200,
          headers: {
            Link: `<https://api.github.com/repos/${REPO}/issues?per_page=100&page=2>; rel="next"`,
          },
        }
      )
    }) as typeof fetch

    const issuePage = await github.fetchIssuesPage(REPO, 1)
    const issueRequest = requests[0]
    const issueUrl = new URL(issueRequest.url)
    ok(
      "list requests use stable ordering and Link pagination",
      issueUrl.searchParams.get("sort") === "created" &&
        issueUrl.searchParams.get("direction") === "asc" &&
        issueUrl.searchParams.get("per_page") === "100" &&
        issuePage.nextPage === 2 &&
        issuePage.issues.length === 1
    )
    ok(
      "requests use current GitHub headers",
      issueRequest.headers.get("Authorization") ===
        "Bearer github-provider-token" &&
        issueRequest.headers.get("Accept") === "application/vnd.github+json" &&
        issueRequest.headers.get("X-GitHub-Api-Version") === "2026-03-10" &&
        issueRequest.headers.get("User-Agent") ===
          "notion-cookbook-github-sync" &&
        waits === 1 &&
        tokenRepos[0] === REPO
    )

    const paginatedRequests: Request[] = []
    waits = 0
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init)
      paginatedRequests.push(request)
      const page = new URL(request.url).searchParams.get("page")
      const review: GitHubReview = {
        id: page === "1" ? 1 : 2,
        state: page === "1" ? "CHANGES_REQUESTED" : "APPROVED",
        user: { login: "alice" },
        submitted_at: null,
      }
      return new Response(JSON.stringify([review]), {
        status: 200,
        headers:
          page === "1"
            ? {
                Link: `<https://api.github.com/repos/${REPO}/pulls/123/reviews?per_page=100&page=2>; rel="next"`,
              }
            : undefined,
      })
    }) as typeof fetch

    const allReviews = await github.fetchReviews(REPO, 123)
    ok(
      "fetchReviews follows every next link",
      allReviews.length === 2 &&
        allReviews[1].state === "APPROVED" &&
        paginatedRequests.every(
          (request) =>
            new URL(request.url).searchParams.get("per_page") === "100"
        ) &&
        waits === 2
    )

    paginatedRequests.length = 0
    waits = 0
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init)
      paginatedRequests.push(request)
      const page = new URL(request.url).searchParams.get("page")
      const checkRun: GitHubCheckRun = {
        name: page === "1" ? "lint" : "test",
        status: "completed",
        conclusion: "success",
      }
      return new Response(
        JSON.stringify({ total_count: 2, check_runs: [checkRun] }),
        {
          status: 200,
          headers:
            page === "1"
              ? {
                  Link: `<https://api.github.com/repos/${REPO}/commits/abc123/check-runs?per_page=100&page=2>; rel="next"`,
                }
              : undefined,
        }
      )
    }) as typeof fetch

    const allCheckRuns = await github.fetchCheckRuns(REPO, "abc123")
    ok(
      "fetchCheckRuns follows every next link and paces each request",
      allCheckRuns.length === 2 && paginatedRequests.length === 2 && waits === 2
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          state: "failure",
          total_count: 2,
          statuses: [],
        }),
        { status: 200 }
      )) as typeof fetch
    const combinedStatus = await github.fetchCombinedStatus(REPO, "abc123")
    ok(
      "fetchCombinedStatus returns the aggregate classic status",
      combinedStatus.state === "failure" && combinedStatus.total_count === 2
    )

    globalThis.fetch = (async () =>
      new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "7" },
      })) as typeof fetch
    let rateLimitError: unknown
    try {
      await github.fetchIssuesPage(REPO, 1)
    } catch (error) {
      rateLimitError = error
    }
    ok(
      "surfaces Retry-After through RateLimitError",
      rateLimitError instanceof RateLimitError &&
        rateLimitError.retryAfter === 7
    )

    globalThis.fetch = (async () =>
      new Response("You have exceeded a secondary rate limit.", {
        status: 403,
      })) as typeof fetch
    let secondaryRateLimitError: unknown
    try {
      await github.fetchIssuesPage(REPO, 1)
    } catch (error) {
      secondaryRateLimitError = error
    }
    ok(
      "uses a 60-second fallback for secondary rate limits",
      secondaryRateLimitError instanceof RateLimitError &&
        secondaryRateLimitError.retryAfter === 60
    )

    globalThis.fetch = (async () =>
      new Response("API rate limit exceeded", {
        status: 403,
        headers: { "X-RateLimit-Remaining": "0" },
      })) as typeof fetch
    let missingResetError: unknown
    try {
      await github.fetchIssuesPage(REPO, 1)
    } catch (error) {
      missingResetError = error
    }
    ok(
      "falls back safely when a primary-limit reset header is missing",
      missingResetError instanceof RateLimitError &&
        missingResetError.retryAfter === 60
    )

    globalThis.fetch = (async () =>
      new Response("forbidden", {
        status: 403,
        headers: { "X-RateLimit-Remaining": "4999" },
      })) as typeof fetch
    let permissionError: unknown
    try {
      await github.fetchIssuesPage(REPO, 1)
    } catch (error) {
      permissionError = error
    }
    ok(
      "does not misclassify ordinary permission failures as rate limits",
      permissionError instanceof Error &&
        !(permissionError instanceof RateLimitError)
    )

    const openSyncRequests: Request[] = []
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init)
      openSyncRequests.push(request)
      const url = new URL(request.url)

      if (url.pathname.endsWith("/pulls")) {
        return new Response(JSON.stringify([closedPR, standardPR]), {
          status: 200,
        })
      }
      if (url.pathname.endsWith("/reviews")) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.pathname.endsWith("/check-runs")) {
        return new Response(
          JSON.stringify({ total_count: 0, check_runs: [] }),
          { status: 200 }
        )
      }
      if (url.pathname.endsWith("/status")) {
        return new Response(
          JSON.stringify({ state: "pending", total_count: 0, statuses: [] }),
          { status: 200 }
        )
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const openSyncResult = (await worker.run(
      "openPullRequestsSync",
      githubPacerContext(),
      { concreteOutput: true }
    )) as WorkerRunResult
    const openListUrl = new URL(openSyncRequests[0].url)
    ok(
      "open PR replacement scans all states in stable order",
      openListUrl.searchParams.get("state") === "all" &&
        openListUrl.searchParams.get("sort") === "created" &&
        openListUrl.searchParams.get("direction") === "asc"
    )
    ok(
      "open PR replacement filters closed PRs before enrichment",
      openSyncResult.changes.length === 1 &&
        openSyncResult.changes[0].key === `${REPO}#${standardPR.number}` &&
        openSyncRequests.length === 4
    )

    process.env.GITHUB_REPOS = `${REPO},acme/api`
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([]), { status: 200 })) as typeof fetch
    const multiRepoResult = (await worker.run(
      "issuesSync",
      githubPacerContext(),
      { concreteOutput: true }
    )) as WorkerRunResult
    ok(
      "sync state advances to the next configured repository",
      multiRepoResult.hasMore &&
        multiRepoResult.nextUserContext?.repoIndex === 1 &&
        multiRepoResult.nextUserContext.page === 1
    )
  } finally {
    globalThis.fetch = originalFetch
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = originalToken
    if (originalRepos === undefined) delete process.env.GITHUB_REPOS
    else process.env.GITHUB_REPOS = originalRepos
  }
}

runAuthTests()
  .then(runApiClientTests)
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    if (failed > 0) process.exit(1)
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
