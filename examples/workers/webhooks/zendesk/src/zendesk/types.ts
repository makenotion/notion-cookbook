export type ZendeskTicket = {
  ticketId: string
  ticketUrl: string
  email: string
  subject: string
  description: string
  assignee: string
  status: string
  latestComment: string
  createdAt: string
}

export type ZendeskComment = {
  id: number
  type?: string
  body?: string
  plain_body?: string
  public?: boolean
  author_id?: number
  created_at?: string
}

export type ZendeskUser = {
  id: number
  name?: string
}

export type ListCommentsResponse = {
  comments?: ZendeskComment[]
  users?: ZendeskUser[]
  next_page?: string | null
}

export type ShowTicketResponse = {
  ticket: {
    id: number
    status: string
  }
}
