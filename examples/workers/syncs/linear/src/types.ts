// Fields we pull from Linear's GraphQL `issues` connection. Extend this if
// you need more columns in the Notion database — remember to add the field
// to the GraphQL query in `linear.ts` and to the schema/mapping in `index.ts`.
export interface LinearIssue {
  id: string
  identifier: string // e.g. "ENG-123"
  title: string
  url: string
  priority: number // 0 = none, 1 = urgent, 2 = high, 3 = medium, 4 = low
  priorityLabel: string
  updatedAt: string // ISO 8601
  state: { name: string } | null
  assignee: { name: string } | null
  labels: { nodes: { name: string }[] }
}

// A single page of issues returned by Linear's Relay-style pagination.
export interface IssuePage {
  nodes: LinearIssue[]
  hasNextPage: boolean
  endCursor: string | null
}
