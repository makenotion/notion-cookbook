// Offline tests for the github sync worker.
// No GitHub connection is made — all assertions run against pure functions.
// Run: npm test  (or: npx tsx test.ts)

import { issueToChange } from "./src/issues.js"
import { pullRequestToChange } from "./src/all-pull-requests.js"
import {
  openPullRequestToChange,
  reviewState,
  ciStatus,
} from "./src/open-pull-requests.js"
import { dateOnly } from "./src/helpers.js"
import { getRepos } from "./src/github.js"
import type {
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
ok("empty assignees omits Assignees", minimalChange.properties.Assignees === undefined)
ok("empty labels omits Labels", minimalChange.properties.Labels === undefined)
ok("null milestone omits Milestone", minimalChange.properties.Milestone === undefined)
ok("null state_reason omits State Reason", minimalChange.properties["State Reason"] === undefined)
ok("null body gives empty pageContentMarkdown", minimalChange.pageContentMarkdown === "")

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
  merged_by: null,
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
ok("null merged_by omits Merged By", prChange.properties["Merged By"] === undefined)

// ---------------------------------------------------------------------------
// pullRequestToChange — merged PR
// ---------------------------------------------------------------------------

console.log("pullRequestToChange — merged PR:")

const mergedPR: GitHubPullRequest = {
  ...standardPR,
  state: "closed",
  closed_at: "2024-06-17T12:00:00Z",
  merged_at: "2024-06-17T12:00:00Z",
  merged_by: { login: "eve" },
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
ok(
  "Merged By is set",
  JSON.stringify(mergedChange.properties["Merged By"]).includes("eve")
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
  merged_by: null,
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
ok("null merged_at omits Merged", closedPRChange.properties.Merged === undefined)
ok("null merged_by omits Merged By", closedPRChange.properties["Merged By"] === undefined)

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
  merged_by: null,
  html_url: "https://github.com/acme/widgets/pull/1",
  closed_at: null,
  merged_at: null,
  created_at: "2024-01-01",
  updated_at: "2024-01-01",
}

const minimalPRChange = pullRequestToChange(minimalPR, REPO)

ok("null user omits Author", minimalPRChange.properties.Author === undefined)
ok("empty assignees omits Assignees", minimalPRChange.properties.Assignees === undefined)
ok("empty reviewers omits Reviewers", minimalPRChange.properties.Reviewers === undefined)
ok("empty labels omits Labels", minimalPRChange.properties.Labels === undefined)
ok("null milestone omits Milestone", minimalPRChange.properties.Milestone === undefined)
ok("null body gives empty pageContentMarkdown", minimalPRChange.pageContentMarkdown === "")

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
    { id: 2, state: "CHANGES_REQUESTED", user: { login: "bob" }, submitted_at: null },
  ]) === "Changes Requested"
)

ok(
  "later approval from same author overrides changes requested",
  reviewState([
    { id: 1, state: "CHANGES_REQUESTED", user: { login: "alice" }, submitted_at: null },
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

ok("empty check runs returns undefined", ciStatus([]) === undefined)

ok(
  "all success",
  ciStatus([
    { name: "lint", status: "completed", conclusion: "success" },
    { name: "test", status: "completed", conclusion: "success" },
  ]) === "Success"
)

ok(
  "any failure",
  ciStatus([
    { name: "lint", status: "completed", conclusion: "success" },
    { name: "test", status: "completed", conclusion: "failure" },
  ]) === "Failure"
)

ok(
  "in-progress means pending",
  ciStatus([
    { name: "lint", status: "completed", conclusion: "success" },
    { name: "test", status: "in_progress", conclusion: null },
  ]) === "Pending"
)

// ---------------------------------------------------------------------------
// openPullRequestToChange — enriched open PR
// ---------------------------------------------------------------------------

console.log("openPullRequestToChange — with reviews and checks:")

const reviews: GitHubReview[] = [
  { id: 1, state: "APPROVED", user: { login: "carol" }, submitted_at: "2024-06-16T12:00:00Z" },
]
const checks: GitHubCheckRun[] = [
  { name: "CI", status: "completed", conclusion: "success" },
]

const openChange = openPullRequestToChange(standardPR, REPO, reviews, checks)

ok(
  "Review State is Approved",
  JSON.stringify(openChange.properties["Review State"]).includes("Approved")
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

const bareChange = openPullRequestToChange(standardPR, REPO, [], [])

ok("no reviews omits Review State", bareChange.properties["Review State"] === undefined)
ok("no checks omits CI Status", bareChange.properties["CI Status"] === undefined)

// ---------------------------------------------------------------------------
// dateOnly
// ---------------------------------------------------------------------------

console.log("dateOnly:")

ok("ISO timestamp returns date part", dateOnly("2024-03-15T12:00:00Z") === "2024-03-15")
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

process.env.GITHUB_REPOS = "single/repo"
ok("single repo works", getRepos().length === 1)

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

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
