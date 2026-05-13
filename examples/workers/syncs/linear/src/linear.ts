import type { IssuePage, LinearIssue } from "./types.js"

// Linear exposes a single GraphQL endpoint. Personal API keys go in the
// `Authorization` header **without** a "Bearer" prefix. See:
// https://linear.app/developers/graphql
const LINEAR_ENDPOINT = "https://api.linear.app/graphql"

const ISSUE_FIELDS = `
	id
	identifier
	title
	url
	priority
	priorityLabel
	updatedAt
	state { name }
	assignee { name }
	labels { nodes { name } }
`

async function graphql<T>(
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const apiKey = process.env.LINEAR_API_KEY
  if (!apiKey) {
    throw new Error(
      "LINEAR_API_KEY is not set. Run `ntn workers env set LINEAR_API_KEY=...`."
    )
  }

  const res = await fetch(LINEAR_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    throw new Error(`Linear API error: ${res.status} ${await res.text()}`)
  }

  const body = (await res.json()) as { data?: T; errors?: unknown }
  if (body.errors) {
    throw new Error(`Linear GraphQL errors: ${JSON.stringify(body.errors)}`)
  }
  if (!body.data) {
    throw new Error("Linear GraphQL response missing `data`")
  }
  return body.data
}

// Backfill: fetch every issue, page by page, with no time filter.
// Used by the manual replace-mode sync to populate or fully refresh the
// Notion database.
export async function fetchAllIssuesPage(
  after: string | null
): Promise<IssuePage> {
  const query = `
		query Backfill($after: String) {
			issues(first: 100, after: $after) {
				nodes { ${ISSUE_FIELDS} }
				pageInfo { hasNextPage endCursor }
			}
		}
	`
  const data = await graphql<{
    issues: {
      nodes: LinearIssue[]
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
    }
  }>(query, { after })
  return {
    nodes: data.issues.nodes,
    hasNextPage: data.issues.pageInfo.hasNextPage,
    endCursor: data.issues.pageInfo.endCursor,
  }
}

// Delta: fetch only issues updated after a given timestamp. Paginated so
// catch-up cycles after a backlog work correctly.
export async function fetchIssuesUpdatedSince(
  since: string,
  after: string | null
): Promise<IssuePage> {
  const query = `
		query Delta($since: DateTimeOrDuration!, $after: String) {
			issues(
				first: 100
				after: $after
				filter: { updatedAt: { gt: $since } }
			) {
				nodes { ${ISSUE_FIELDS} }
				pageInfo { hasNextPage endCursor }
			}
		}
	`
  const data = await graphql<{
    issues: {
      nodes: LinearIssue[]
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
    }
  }>(query, { since, after })
  return {
    nodes: data.issues.nodes,
    hasNextPage: data.issues.pageInfo.hasNextPage,
    endCursor: data.issues.pageInfo.endCursor,
  }
}
