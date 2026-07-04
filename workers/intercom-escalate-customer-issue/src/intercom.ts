import type { RuntimeConfig } from "./config.js"
import { intercomBaseUrl } from "./config.js"
import { requestJson, type FetchLike } from "./http.js"
import type {
  CompanySnapshot,
  ContactSnapshot,
  IntercomGateway,
  SourceAttachment,
  SourceKind,
  SourcePart,
  SourceSnapshot,
} from "./types.js"
import { ProviderError, SafetyError } from "./types.js"

interface IntercomClientOptions {
  fetchFn?: FetchLike
  sleep?: (milliseconds: number) => Promise<void>
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError(
      "INVALID_PROVIDER_RESPONSE",
      `Intercom returned an invalid ${label}.`,
      200
    )
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string, maximum = 10_000): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new ProviderError(
      "INVALID_PROVIDER_RESPONSE",
      `Intercom returned an invalid ${label}.`,
      200
    )
  }
  return value
}

function optionalString(value: unknown, maximum = 10_000): string | null {
  return typeof value === "string" && value.length <= maximum ? value : null
}

function assigneeId(
  value: unknown,
  kind: SourceKind,
  label: string
): string | null {
  if (
    value === null ||
    value === undefined ||
    value === 0 ||
    value === "0" ||
    value === ""
  ) {
    return null
  }
  if (
    kind === "conversation" &&
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  ) {
    return String(value)
  }
  if (
    typeof value === "string" &&
    value.length <= 100 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  ) {
    return value
  }
  throw new ProviderError(
    "INVALID_PROVIDER_RESPONSE",
    `Intercom returned an invalid ${label}; Ticket assignee IDs must remain strings and Conversation IDs must be safe integers or strings.`,
    200
  )
}

function finiteInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProviderError(
      "INVALID_PROVIDER_RESPONSE",
      `Intercom returned an invalid ${label}.`,
      200
    )
  }
  return value as number
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8_000)
}

function attachments(value: unknown): SourceAttachment[] {
  if (!Array.isArray(value)) return []
  if (value.length > 20) {
    throw new SafetyError(
      "SOURCE_LIMIT",
      "One Intercom part contains more than 20 attachments."
    )
  }
  return value.map((entry, index) => {
    const item = object(entry, `attachment ${index}`)
    const name =
      optionalString(item.name, 500) ??
      optionalString(item.filename, 500) ??
      `attachment-${index + 1}`
    const contentType =
      optionalString(item.content_type, 200) ??
      optionalString(item.contentType, 200)
    const sizeValue = item.filesize ?? item.size
    const size =
      sizeValue === null || sizeValue === undefined
        ? null
        : finiteInteger(sizeValue, "attachment size")
    return { name: stripHtml(name).slice(0, 200), contentType, size }
  })
}

function parts(
  value: unknown,
  field: "conversation_parts" | "ticket_parts"
): {
  items: SourcePart[]
  total: number
} {
  if (value === null || value === undefined) return { items: [], total: 0 }
  const wrapper = object(value, field)
  const raw = wrapper[field]
  if (!Array.isArray(raw))
    throw new ProviderError(
      "INVALID_PROVIDER_RESPONSE",
      "Intercom parts are invalid.",
      200
    )
  const total =
    wrapper.total_count === undefined
      ? raw.length
      : finiteInteger(wrapper.total_count, "part count")
  if (total > 500 || raw.length > 500 || total > raw.length) {
    throw new SafetyError(
      "SOURCE_LIMIT",
      "The Intercom record exceeds the 500-part verification bound; no mutation was attempted."
    )
  }
  const items = raw.map((entry, index) => {
    const part = object(entry, `part ${index}`)
    return {
      id: string(part.id, "part ID", 100),
      type: optionalString(part.part_type, 100) ?? "unknown",
      body: stripHtml(optionalString(part.body, 40_000) ?? ""),
      attachments: attachments(part.attachments),
    }
  })
  return { items, total }
}

function tags(value: unknown): { id: string; name: string }[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  const raw = (value as Record<string, unknown>).tags
  if (!Array.isArray(raw) || raw.length > 100) {
    throw new SafetyError(
      "SOURCE_LIMIT",
      "Intercom tags exceed the 100-tag verification bound."
    )
  }
  return raw.map((entry, index) => {
    const tag = object(entry, `tag ${index}`)
    return {
      id: string(tag.id, "tag ID", 100),
      name: stripHtml(string(tag.name, "tag name", 500)).slice(0, 100),
    }
  })
}

function contactIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  const raw = (value as Record<string, unknown>).contacts
  if (!Array.isArray(raw) || raw.length > 20) {
    throw new SafetyError(
      "SOURCE_LIMIT",
      "Intercom contacts exceed the 20-contact verification bound."
    )
  }
  return raw.map((entry, index) =>
    string(object(entry, `contact ${index}`).id, "contact ID", 100)
  )
}

export class IntercomClient implements IntercomGateway {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>

  constructor(
    private readonly config: RuntimeConfig,
    private readonly options: IntercomClientOptions = {}
  ) {
    this.baseUrl = intercomBaseUrl(config.intercomRegion)
    this.headers = {
      Accept: "application/json",
      Authorization: `Bearer ${config.intercomToken}`,
      "Content-Type": "application/json",
      "Intercom-Version": "2.15",
    }
  }

  private request<T>(
    path: string,
    init: RequestInit = {},
    mutation = false,
    expected = [200]
  ): Promise<T> {
    return requestJson<T>(
      "Intercom",
      `${this.baseUrl}${path}`,
      { ...init, headers: { ...this.headers, ...(init.headers ?? {}) } },
      {
        fetchFn: this.options.fetchFn,
        sleep: this.options.sleep,
        timeoutMs: this.config.requestTimeoutMs,
        mutation,
        expectedStatuses: expected,
      }
    )
  }

  async getIdentity(): Promise<{ adminId: string; workspaceId: string }> {
    const raw = object(await this.request<unknown>("/me"), "identity")
    const app = object(raw.app, "workspace identity")
    return {
      adminId: string(raw.id, "admin ID", 100),
      workspaceId: string(app.id_code, "workspace ID", 100),
    }
  }

  async getSource(kind: SourceKind, id: string): Promise<SourceSnapshot> {
    const path =
      kind === "conversation"
        ? `/conversations/${encodeURIComponent(id)}?display_as=plaintext`
        : `/tickets/${encodeURIComponent(id)}`
    const raw = object(await this.request<unknown>(path), kind)
    if (raw.id !== id)
      throw new ProviderError(
        "SOURCE_ID_MISMATCH",
        "Intercom returned a different source ID.",
        200
      )
    const partData = parts(
      kind === "conversation" ? raw.conversation_parts : raw.ticket_parts,
      kind === "conversation" ? "conversation_parts" : "ticket_parts"
    )
    const contacts = contactIds(raw.contacts)
    const company =
      raw.company &&
      typeof raw.company === "object" &&
      !Array.isArray(raw.company)
        ? optionalString((raw.company as Record<string, unknown>).id, 100)
        : null
    const attributes =
      raw.ticket_attributes &&
      typeof raw.ticket_attributes === "object" &&
      !Array.isArray(raw.ticket_attributes)
        ? (raw.ticket_attributes as Record<string, unknown>)
        : {}
    const source =
      raw.source && typeof raw.source === "object" && !Array.isArray(raw.source)
        ? (raw.source as Record<string, unknown>)
        : {}
    const sla =
      raw.sla_applied &&
      typeof raw.sla_applied === "object" &&
      !Array.isArray(raw.sla_applied)
        ? optionalString(
            (raw.sla_applied as Record<string, unknown>).sla_status,
            100
          )
        : null
    const ticketState =
      raw.ticket_state &&
      typeof raw.ticket_state === "object" &&
      !Array.isArray(raw.ticket_state)
        ? (optionalString(
            (raw.ticket_state as Record<string, unknown>).category,
            100
          ) ??
          optionalString(
            (raw.ticket_state as Record<string, unknown>).name,
            100
          ))
        : null
    return {
      kind,
      id,
      updatedAt: finiteInteger(raw.updated_at, "updated_at"),
      state: (
        optionalString(raw.state, 100) ??
        ticketState ??
        (raw.open === false ? "resolved" : "submitted")
      )
        .toLowerCase()
        .replace(/\s+/g, "_"),
      title: stripHtml(
        optionalString(raw.title, 10_000) ??
          optionalString(attributes._default_title_, 10_000) ??
          ""
      ),
      openingBody: stripHtml(
        optionalString(source.body, 40_000) ??
          optionalString(attributes._default_description_, 40_000) ??
          ""
      ),
      contactIds: contacts,
      companyId: company,
      teamAssigneeId: assigneeId(
        raw.team_assignee_id,
        kind,
        "team assignee ID"
      ),
      adminAssigneeId: assigneeId(
        raw.admin_assignee_id,
        kind,
        "admin assignee ID"
      ),
      slaStatus: sla,
      tags: tags(raw.tags),
      parts: partData.items,
      totalParts: partData.total,
    }
  }

  async getContact(id: string): Promise<ContactSnapshot> {
    const raw = object(
      await this.request<unknown>(`/contacts/${encodeURIComponent(id)}`),
      "contact"
    )
    if (raw.id !== id)
      throw new ProviderError(
        "CONTACT_ID_MISMATCH",
        "Intercom returned a different contact ID.",
        200
      )
    const embedded =
      raw.companies &&
      typeof raw.companies === "object" &&
      !Array.isArray(raw.companies)
        ? (raw.companies as Record<string, unknown>).data
        : []
    const companyIds = Array.isArray(embedded)
      ? embedded
          .slice(0, 10)
          .map((entry, index) =>
            string(object(entry, `company ${index}`).id, "company ID", 100)
          )
      : []
    return {
      id,
      name: optionalString(raw.name, 500)?.slice(0, 200) ?? null,
      companyIds,
    }
  }

  async getCompany(id: string): Promise<CompanySnapshot> {
    const raw = object(
      await this.request<unknown>(`/companies/${encodeURIComponent(id)}`),
      "company"
    )
    if (raw.id !== id)
      throw new ProviderError(
        "COMPANY_ID_MISMATCH",
        "Intercom returned a different company ID.",
        200
      )
    return { id, name: optionalString(raw.name, 500)?.slice(0, 200) ?? null }
  }

  async listContactCompanyIds(id: string): Promise<string[]> {
    const output: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 3; page += 1) {
      const query = cursor
        ? `?per_page=50&starting_after=${encodeURIComponent(cursor)}`
        : "?per_page=50"
      const raw = object(
        await this.request<unknown>(
          `/contacts/${encodeURIComponent(id)}/companies${query}`
        ),
        "company page"
      )
      const companies = raw.data ?? raw.companies
      if (!Array.isArray(companies) || companies.length > 50) {
        throw new ProviderError(
          "INVALID_PROVIDER_RESPONSE",
          "Intercom company pagination is invalid.",
          200
        )
      }
      for (const entry of companies)
        output.push(string(object(entry, "company").id, "company ID", 100))
      const pages =
        raw.pages && typeof raw.pages === "object" && !Array.isArray(raw.pages)
          ? (raw.pages as Record<string, unknown>)
          : null
      const next =
        pages?.next &&
        typeof pages.next === "object" &&
        !Array.isArray(pages.next)
          ? optionalString(
              (pages.next as Record<string, unknown>).starting_after,
              500
            )
          : null
      if (!next) return output
      if (next === cursor)
        throw new SafetyError(
          "PAGINATION_STALLED",
          "Intercom returned a repeated company cursor."
        )
      cursor = next
    }
    throw new SafetyError(
      "SOURCE_LIMIT",
      "Contact company membership exceeds the 150-company verification bound."
    )
  }

  async addTag(kind: SourceKind, id: string, tagId: string): Promise<void> {
    await this.request(
      `/${kind === "conversation" ? "conversations" : "tickets"}/${encodeURIComponent(id)}/tags`,
      {
        method: "POST",
        body: JSON.stringify({
          id: tagId,
          admin_id: this.config.intercomAdminId,
        }),
      },
      true
    )
  }

  async routeToTeam(
    kind: SourceKind,
    id: string,
    teamId: string
  ): Promise<void> {
    if (kind === "conversation") {
      await this.request(
        `/conversations/${encodeURIComponent(id)}/parts`,
        {
          method: "POST",
          body: JSON.stringify({
            message_type: "assignment",
            type: "team",
            admin_id: this.config.intercomAdminId,
            assignee_id: teamId,
          }),
        },
        true
      )
      return
    }
    await this.request(
      `/tickets/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          skip_notifications: true,
          assignment: {
            admin_id: this.config.intercomAdminId,
            assignee_id: teamId,
          },
        }),
      },
      true
    )
  }

  async addInternalNote(
    kind: SourceKind,
    id: string,
    body: string
  ): Promise<void> {
    const path = `/${kind === "conversation" ? "conversations" : "tickets"}/${encodeURIComponent(id)}/reply`
    const response = await this.request<unknown>(
      path,
      {
        method: "POST",
        body: JSON.stringify({
          message_type: "note",
          type: "admin",
          admin_id: this.config.intercomAdminId,
          body,
        }),
      },
      true
    )
    try {
      const raw = object(response, "internal note")
      const partType = optionalString(raw.part_type, 100)
      if (partType && partType !== "note") {
        throw new ProviderError(
          "CUSTOMER_REPLY_RISK",
          "Intercom did not confirm an internal note response.",
          200,
          {
            ambiguous: true,
          }
        )
      }
      // Conversation replies return the conversation rather than the new part;
      // the orchestrator always re-reads the source and resolves the fixed marker.
      if (typeof raw.id !== "string") {
        throw new ProviderError(
          "INVALID_PROVIDER_RESPONSE",
          "Intercom did not identify the note response.",
          200,
          {
            ambiguous: true,
          }
        )
      }
    } catch (error) {
      if (error instanceof ProviderError && error.ambiguous) throw error
      throw new ProviderError(
        "MUTATION_OUTCOME_UNKNOWN",
        "Intercom note crossed the write boundary but its response shape was invalid; marker reconciliation is required.",
        error instanceof ProviderError ? error.httpStatus : 200,
        { ambiguous: true }
      )
    }
  }
}
