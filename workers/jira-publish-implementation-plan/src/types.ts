export type DraftNode = {
  clientKey: string
  summary: string
  description: string
  acceptanceCriteria: string
  issueTypeName: string
  issueTypeId: string | null
  assigneeName: string | null
  assigneeAccountId: string | null
  labels: string[]
  estimate: number | null
  fixVersionName: string | null
  fixVersionId: string | null
}

export type PlanDependency = {
  blockerClientKey: string
  blockedClientKey: string
}

export type DraftPlan = {
  sourcePageId: string
  epic: DraftNode
  children: DraftNode[]
  dependencies: PlanDependency[]
}

export type PageSnapshot = {
  pageId: string
  url: string
  lastEditedTime: string
}

export type JiraNamedRef = {
  id: string
  name: string
}

export type JiraProjectRef = JiraNamedRef & {
  key: string
  url: string
}

export type JiraLinkTypeRef = JiraNamedRef & {
  outward: string
  inward: string
}

export type PreparedNode = {
  clientKey: string
  summary: string
  description: string
  acceptanceCriteria: string
  issueType: JiraNamedRef
  assignee: JiraNamedRef | null
  labels: string[]
  estimate: number | null
  fixVersion: JiraNamedRef | null
}

export type PreparedPlanData = {
  source: PageSnapshot
  project: JiraProjectRef
  blocksLinkType: JiraLinkTypeRef
  estimateFieldId: string | null
  epic: PreparedNode
  children: PreparedNode[]
  dependencies: PlanDependency[]
}

export type PreparedPlan = PreparedPlanData & {
  planVersion: string
}

export type ResolutionCandidate = {
  id: string
  label: string
  detail: string
}

export type ResolutionChoice = {
  field: string
  query: string
  candidates: ResolutionCandidate[]
  hasMore: boolean
}

export type JiraIssueView = {
  clientKey: string
  id: string
  key: string
  url: string
  summary: string
  issueType: string
  assignee: string | null
  parentKey: string | null
}

export type JiraDependencyView = PlanDependency & {
  state: "existing" | "missing"
}

export type InspectStatus =
  | "complete"
  | "partial"
  | "not_observed"
  | "conflict"
  | "blocked"

export type InspectResult = {
  ok: boolean
  status: InspectStatus
  source: PageSnapshot | null
  project: JiraProjectRef | null
  planVersion: string | null
  issues: JiraIssueView[]
  dependencies: JiraDependencyView[]
  missingClientKeys: string[]
  hasMore: boolean
  warnings: string[]
  message: string
  nextAction: "none" | "inspect_again" | "prepare_again" | "manual_review"
}

export type PrepareStatus =
  | "ready"
  | "needs_choice"
  | "already_published"
  | "partial"
  | "conflict"
  | "blocked"

export type PrepareResult = {
  ok: boolean
  status: PrepareStatus
  preparedPlan: PreparedPlan | null
  choices: ResolutionChoice[]
  observedIssues: JiraIssueView[]
  warnings: string[]
  message: string
  nextAction:
    | "ask_user"
    | "confirm_publish"
    | "no_action"
    | "inspect_again"
    | "manual_review"
}

export type IssueOutcome = {
  clientKey: string
  state: "created" | "existing" | "rejected" | "not_attempted" | "unknown"
  id: string | null
  key: string | null
  url: string | null
}

export type DependencyOutcome = PlanDependency & {
  state: "created" | "existing" | "rejected" | "not_attempted" | "unknown"
}

export type PublishStatus =
  | "completed"
  | "no_op"
  | "partial"
  | "ambiguous"
  | "conflict"
  | "blocked"

export type PublishResult = {
  ok: boolean
  status: PublishStatus
  changed: boolean | null
  source: PageSnapshot
  project: JiraProjectRef
  planVersion: string
  issues: IssueOutcome[]
  dependencies: DependencyOutcome[]
  warnings: string[]
  message: string
  nextAction: "none" | "inspect_again" | "prepare_again" | "manual_review"
  retryAfterSeconds: number | null
  requestId: string | null
}

export type JiraPlanMarker = {
  version: 1
  sourcePageId: string
  sourceLastEditedTime: string
  planVersion: string
  clientKey: string
  expectedClientKeys: string[]
  dependencies: PlanDependency[]
}
