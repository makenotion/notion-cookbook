export type Priority = "P0" | "P1" | "P2" | "P3"

export interface SourceReferenceInput {
  conversationPageId: string | null
  conversationId: string | null
}

export interface InspectConversationInput extends SourceReferenceInput {}

export interface TicketDraft {
  title: string
  priority: Priority
  summary: string
  impact: string
  environment: string | null
  reproductionSteps: string[]
}

export interface CreateTicketInput {
  conversationId: string
  inspectionVersion: string
  ticketDraft: TicketDraft | null
}

export interface ExistingTicketView {
  pageId: string
  url: string
}

export interface InspectConversationResult {
  conversationId: string
  intercomUrl: string
  sourcePageId: string | null
  sourcePageUrl: string | null
  inspectionVersion: string
  state: string
  priority: boolean
  title: string
  openingMessage: string | null
  customer: { id: string; name: string | null } | null
  company: { id: string; name: string | null } | null
  currentTeamId: string | null
  slaStatus: string | null
  tags: { id: string; name: string }[]
  evidence: {
    partId: string
    createdAt: number
    role: "customer" | "support"
    text: string
  }[]
  evidenceTruncated: boolean
  partsTruncated: boolean
  existingTicket: ExistingTicketView | null
  ticketCreationState: "none" | "existing"
  plannedRoute: {
    teamId: string
    teamName: string
    tagId: string
    tagName: string
  }
  message: string
}

export type ActionState = "applied" | "unchanged" | "pending" | "unknown"

export interface CreateTicketResult {
  ok: boolean
  status:
    | "completed"
    | "no_op"
    | "conflict"
    | "partial_failure"
    | "ambiguous"
    | "blocked"
  changed: boolean | null
  conversationId: string
  ticket: {
    pageId: string | null
    url: string | null
    action: "created" | "existing" | "unknown" | "none"
  }
  intercom: {
    tag: ActionState
    route: ActionState
    note: ActionState
  }
  customerVisibleReplySent: false
  retryable: boolean
  nextStep: string | null
  message: string
}

export class EscalationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: Exclude<
      CreateTicketResult["status"],
      "completed" | "no_op"
    > = "blocked",
    public readonly retryable = false,
    public readonly ambiguous = false
  ) {
    super(message)
    this.name = "EscalationError"
  }
}
