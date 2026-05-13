// Subset of fields we read from Zendesk's incremental tickets export.
// Add more fields by extending the type, then update `mapping.ts` and the
// schema in `index.ts`. The full ticket shape is documented at
// https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/

export interface ZdTicket {
  id: number
  subject: string
  // "new" | "open" | "pending" | "hold" | "solved" | "closed" | "deleted"
  status: string
  priority: string | null // "low" | "normal" | "high" | "urgent" | null
  requester_id: number | null
  assignee_id: number | null
  tags: string[]
  updated_at: string // ISO 8601
  url: string // API URL, not the agent-facing URL

  // Zendesk returns custom fields as a flat array of { id, value }. Each
  // id corresponds to a custom-field definition in your account. See
  // the `mapping.ts` example for how to read one by id.
  custom_fields: { id: number; value: unknown }[]
}

// Cursor-based incremental export response shape.
export interface ZdIncrementalResponse {
  tickets: ZdTicket[]
  after_cursor: string | null
  after_url: string | null
  end_of_stream: boolean
}
