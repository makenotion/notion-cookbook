// Offline tests for the jira sync worker.
// No Jira connection is made — all assertions run against pure functions.
// Run: npm test  (or: npx tsx test.ts)

import { issueToChange } from "./src/issues.js"
import { sprintToChange } from "./src/sprints.js"
import { projectToChange } from "./src/projects.js"
import { browseUrl, getEpicName, getStoryPoints, extractTextFromAdf } from "./src/jira.js"
import { dateOnly } from "./src/helpers.js"
import type { JiraIssue, JiraSprint, JiraProject, BoardLookup } from "./src/jira.js"

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

const BASE_URL = "https://acme.atlassian.net"

// ---------------------------------------------------------------------------
// issueToChange — standard issue
// ---------------------------------------------------------------------------

console.log("issueToChange — standard issue:")

const standardIssue: JiraIssue = {
  key: "PROJ-123",
  self: "https://acme.atlassian.net/rest/api/3/issue/10001",
  fields: {
    summary: "Login button is broken on mobile",
    status: { name: "In Progress", statusCategory: { name: "In Progress" } },
    issuetype: { name: "Bug" },
    priority: { name: "High" },
    assignee: { displayName: "Alice Smith" },
    reporter: { displayName: "Bob Jones" },
    project: { key: "PROJ", name: "Project Alpha" },
    labels: ["frontend", "mobile"],
    components: [{ name: "Web App" }, { name: "Auth" }],
    fixVersions: [{ name: "v2.1" }],
    resolution: null,
    description: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "The login button doesn't respond on iOS Safari." }] },
        { type: "paragraph", content: [{ type: "text", text: "Steps to reproduce:" }] },
        { type: "orderedList", content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Open app on iPhone" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Tap login button" }] }] },
        ] },
      ],
    },
    duedate: "2024-06-30",
    created: "2024-06-01T10:00:00.000Z",
    updated: "2024-06-16T14:00:00.000Z",
    sprint: { name: "Sprint 42", state: "active" },
    parent: { key: "PROJ-100", fields: { summary: "Mobile Improvements" } },
  },
}

const issueChange = issueToChange(standardIssue, BASE_URL)

ok("type is upsert", issueChange.type === "upsert")
ok("key is issue key", issueChange.key === "PROJ-123")
ok(
  "Summary is set",
  JSON.stringify(issueChange.properties.Summary).includes("Login button")
)
ok(
  "Status is set",
  JSON.stringify(issueChange.properties.Status).includes("In Progress")
)
ok(
  "Issue Type is set",
  JSON.stringify(issueChange.properties["Issue Type"]).includes("Bug")
)
ok(
  "Assignee is display name",
  JSON.stringify(issueChange.properties.Assignee).includes("Alice Smith")
)
ok(
  "Sprint name is set",
  JSON.stringify(issueChange.properties.Sprint).includes("Sprint 42")
)
ok(
  "Updated is set",
  JSON.stringify(issueChange.properties.Updated).includes("2024-06-16")
)
ok(
  "Status Category is set",
  JSON.stringify(issueChange.properties["Status Category"]).includes("In Progress")
)
ok(
  "Priority is set",
  JSON.stringify(issueChange.properties.Priority).includes("High")
)
ok(
  "Reporter is display name",
  JSON.stringify(issueChange.properties.Reporter).includes("Bob Jones")
)
ok(
  "Project name is set",
  JSON.stringify(issueChange.properties.Project).includes("Project Alpha")
)
ok(
  "Issue Link is correct",
  JSON.stringify(issueChange.properties["Issue Link"]).includes(
    "acme.atlassian.net/browse/PROJ-123"
  )
)
ok(
  "Labels contains both",
  JSON.stringify(issueChange.properties.Labels).includes("frontend") &&
    JSON.stringify(issueChange.properties.Labels).includes("mobile")
)
ok(
  "Components contains both",
  JSON.stringify(issueChange.properties.Components).includes("Web App") &&
    JSON.stringify(issueChange.properties.Components).includes("Auth")
)
ok(
  "Fix Versions is set",
  JSON.stringify(issueChange.properties["Fix Versions"]).includes("v2.1")
)
ok("null resolution omits Resolution", issueChange.properties.Resolution === undefined)
ok(
  "Due Date is set",
  JSON.stringify(issueChange.properties["Due Date"]).includes("2024-06-30")
)
ok(
  "Epic from parent summary",
  JSON.stringify(issueChange.properties.Epic).includes("Mobile Improvements")
)
ok(
  "Created is set",
  JSON.stringify(issueChange.properties.Created).includes("2024-06-01")
)
ok(
  "Issue Key is last",
  JSON.stringify(issueChange.properties["Issue Key"]).includes("PROJ-123")
)
ok(
  "pageContentMarkdown contains description text",
  issueChange.pageContentMarkdown.includes("login button doesn't respond")
)

// ---------------------------------------------------------------------------
// issueToChange — resolved issue
// ---------------------------------------------------------------------------

console.log("issueToChange — resolved issue:")

const resolvedIssue: JiraIssue = {
  ...standardIssue,
  fields: {
    ...standardIssue.fields,
    status: { name: "Done", statusCategory: { name: "Done" } },
    resolution: { name: "Fixed" },
  },
}

const resolvedChange = issueToChange(resolvedIssue, BASE_URL)

ok(
  "Status is Done",
  JSON.stringify(resolvedChange.properties.Status).includes("Done")
)
ok(
  "Status Category is Done",
  JSON.stringify(resolvedChange.properties["Status Category"]).includes("Done")
)
ok(
  "Resolution is Fixed",
  JSON.stringify(resolvedChange.properties.Resolution).includes("Fixed")
)

// ---------------------------------------------------------------------------
// issueToChange — minimal issue
// ---------------------------------------------------------------------------

console.log("issueToChange — minimal issue:")

const minimalIssue: JiraIssue = {
  key: "PROJ-1",
  self: "https://acme.atlassian.net/rest/api/3/issue/1",
  fields: {
    summary: "First issue",
    status: null,
    issuetype: null,
    priority: null,
    assignee: null,
    reporter: null,
    project: null,
    labels: [],
    components: [],
    fixVersions: [],
    resolution: null,
    description: null,
    duedate: null,
    created: "2024-01-01",
    updated: "2024-01-01",
    sprint: null,
    parent: null,
  },
}

const minimalChange = issueToChange(minimalIssue, BASE_URL)

ok("null status omits Status", minimalChange.properties.Status === undefined)
ok("null status omits Status Category", minimalChange.properties["Status Category"] === undefined)
ok("null issuetype omits Issue Type", minimalChange.properties["Issue Type"] === undefined)
ok("null priority omits Priority", minimalChange.properties.Priority === undefined)
ok("null assignee omits Assignee", minimalChange.properties.Assignee === undefined)
ok("null reporter omits Reporter", minimalChange.properties.Reporter === undefined)
ok("null project omits Project", minimalChange.properties.Project === undefined)
ok("null sprint omits Sprint", minimalChange.properties.Sprint === undefined)
ok("null parent omits Epic", minimalChange.properties.Epic === undefined)
ok("empty labels omits Labels", minimalChange.properties.Labels === undefined)
ok("empty components omits Components", minimalChange.properties.Components === undefined)
ok("empty fixVersions omits Fix Versions", minimalChange.properties["Fix Versions"] === undefined)
ok("null duedate omits Due Date", minimalChange.properties["Due Date"] === undefined)
ok("null description gives empty pageContentMarkdown", minimalChange.pageContentMarkdown === "")

// ---------------------------------------------------------------------------
// getEpicName — resolves epic from parent
// ---------------------------------------------------------------------------

console.log("getEpicName:")

ok(
  "parent with summary returns summary",
  getEpicName(standardIssue) === "Mobile Improvements"
)

const parentKeyOnly: JiraIssue = {
  ...minimalIssue,
  fields: { ...minimalIssue.fields, parent: { key: "PROJ-50" } },
}
ok("parent with key only returns key", getEpicName(parentKeyOnly) === "PROJ-50")
ok("null parent returns null", getEpicName(minimalIssue) === null)

// ---------------------------------------------------------------------------
// sprintToChange — standard sprint
// ---------------------------------------------------------------------------

console.log("sprintToChange — standard sprint:")

const boards: BoardLookup = new Map([
  [10, "Engineering Board"],
])

const activeSprint: JiraSprint = {
  id: 42,
  name: "Sprint 42",
  state: "active",
  startDate: "2024-06-10T00:00:00.000Z",
  endDate: "2024-06-24T00:00:00.000Z",
  completeDate: null,
  goal: "Ship the mobile login fix",
  originBoardId: 10,
}

const sprintChange = sprintToChange(activeSprint, boards)

ok("key is sprint id", sprintChange.key === "42")
ok(
  "Name is set",
  JSON.stringify(sprintChange.properties.Name).includes("Sprint 42")
)
ok(
  "State is Active",
  JSON.stringify(sprintChange.properties.State).includes("Active")
)
ok(
  "Board resolved to name",
  JSON.stringify(sprintChange.properties.Board).includes("Engineering Board")
)
ok(
  "Start Date is set",
  JSON.stringify(sprintChange.properties["Start Date"]).includes("2024-06-10")
)
ok(
  "End Date is set",
  JSON.stringify(sprintChange.properties["End Date"]).includes("2024-06-24")
)
ok(
  "Goal is set",
  JSON.stringify(sprintChange.properties.Goal).includes("mobile login")
)
ok("null completeDate omits Complete Date", sprintChange.properties["Complete Date"] === undefined)
ok(
  "pageContentMarkdown contains goal",
  sprintChange.pageContentMarkdown.includes("mobile login")
)

// ---------------------------------------------------------------------------
// sprintToChange — closed sprint
// ---------------------------------------------------------------------------

console.log("sprintToChange — closed sprint:")

const closedSprint: JiraSprint = {
  ...activeSprint,
  state: "closed",
  completeDate: "2024-06-23T12:00:00.000Z",
}

const closedSprintChange = sprintToChange(closedSprint, boards)

ok(
  "State is Closed",
  JSON.stringify(closedSprintChange.properties.State).includes("Closed")
)
ok(
  "Complete Date is set",
  JSON.stringify(closedSprintChange.properties["Complete Date"]).includes("2024-06-23")
)

// ---------------------------------------------------------------------------
// sprintToChange — minimal sprint
// ---------------------------------------------------------------------------

console.log("sprintToChange — minimal sprint:")

const minimalSprint: JiraSprint = {
  id: 1,
  name: "Sprint 1",
  state: "future",
  startDate: null,
  endDate: null,
  completeDate: null,
  goal: null,
  originBoardId: 999,
}

const minimalSprintChange = sprintToChange(minimalSprint, boards)

ok("unknown board omits Board", minimalSprintChange.properties.Board === undefined)
ok("null startDate omits Start Date", minimalSprintChange.properties["Start Date"] === undefined)
ok("null endDate omits End Date", minimalSprintChange.properties["End Date"] === undefined)
ok("null goal omits Goal", minimalSprintChange.properties.Goal === undefined)

// ---------------------------------------------------------------------------
// projectToChange — standard project
// ---------------------------------------------------------------------------

console.log("projectToChange — standard project:")

const standardProject: JiraProject = {
  id: "10001",
  key: "PROJ",
  name: "Project Alpha",
  description: "The main engineering project.",
  self: "https://acme.atlassian.net/rest/api/3/project/10001",
  projectTypeKey: "software",
  lead: { displayName: "Carol Manager" },
  projectCategory: { name: "Engineering" },
}

const projectChange = projectToChange(standardProject, BASE_URL)

ok("key is project key", projectChange.key === "PROJ")
ok(
  "Name is set",
  JSON.stringify(projectChange.properties.Name).includes("Project Alpha")
)
ok(
  "Project Key is set",
  JSON.stringify(projectChange.properties["Project Key"]).includes("PROJ")
)
ok(
  "Lead is display name",
  JSON.stringify(projectChange.properties.Lead).includes("Carol Manager")
)
ok(
  "Category is set",
  JSON.stringify(projectChange.properties.Category).includes("Engineering")
)
ok(
  "Project Type maps to label",
  JSON.stringify(projectChange.properties["Project Type"]).includes("Software")
)
ok(
  "Project Link is correct",
  JSON.stringify(projectChange.properties["Project Link"]).includes(
    "acme.atlassian.net/browse/PROJ"
  )
)
ok(
  "pageContentMarkdown contains description",
  projectChange.pageContentMarkdown === "The main engineering project."
)

// ---------------------------------------------------------------------------
// projectToChange — minimal project
// ---------------------------------------------------------------------------

console.log("projectToChange — minimal project:")

const minimalProject: JiraProject = {
  id: "10002",
  key: "MIN",
  name: "Minimal",
  description: null,
  self: "https://acme.atlassian.net/rest/api/3/project/10002",
  projectTypeKey: "business",
  lead: null,
  projectCategory: null,
}

const minimalProjectChange = projectToChange(minimalProject, BASE_URL)

ok("null lead omits Lead", minimalProjectChange.properties.Lead === undefined)
ok("null category omits Category", minimalProjectChange.properties.Category === undefined)
ok("null description gives empty pageContentMarkdown", minimalProjectChange.pageContentMarkdown === "")

// ---------------------------------------------------------------------------
// extractTextFromAdf — converts Atlassian Document Format to plain text
// ---------------------------------------------------------------------------

console.log("extractTextFromAdf:")

ok("null returns empty", extractTextFromAdf(null) === "")
ok("empty object returns empty", extractTextFromAdf({}) === "")

ok(
  "simple paragraph",
  extractTextFromAdf({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Hello world" }] },
    ],
  }).includes("Hello world")
)

ok(
  "multiple paragraphs",
  extractTextFromAdf({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "First" }] },
      { type: "paragraph", content: [{ type: "text", text: "Second" }] },
    ],
  }).includes("First") &&
  extractTextFromAdf({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "First" }] },
      { type: "paragraph", content: [{ type: "text", text: "Second" }] },
    ],
  }).includes("Second")
)

ok(
  "bullet list",
  extractTextFromAdf({
    type: "doc",
    content: [
      { type: "bulletList", content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Item one" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Item two" }] }] },
      ] },
    ],
  }).includes("- Item one")
)

ok(
  "code block",
  extractTextFromAdf({
    type: "doc",
    content: [
      { type: "codeBlock", content: [{ type: "text", text: "const x = 1" }] },
    ],
  }).includes("```")
)

// ---------------------------------------------------------------------------
// browseUrl
// ---------------------------------------------------------------------------

console.log("browseUrl:")

ok(
  "builds correct URL",
  browseUrl("https://acme.atlassian.net", "PROJ-42") ===
    "https://acme.atlassian.net/browse/PROJ-42"
)

// ---------------------------------------------------------------------------
// dateOnly
// ---------------------------------------------------------------------------

console.log("dateOnly:")

ok("ISO timestamp returns date part", dateOnly("2024-03-15T12:00:00Z") === "2024-03-15")
ok("plain date passes through", dateOnly("2024-03-15") === "2024-03-15")
ok("empty string returns empty", dateOnly("") === "")

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
