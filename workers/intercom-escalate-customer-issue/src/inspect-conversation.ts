import { createHash } from "node:crypto"
import { intercomAppBaseUrl, type RuntimeConfig } from "./config.js"
import {
  intercomNoteDigest,
  normalizeIntercomConversationReference,
  type ConversationSnapshot,
  type IntercomClient,
  type IntercomCompany,
  type IntercomContact,
  type IntercomIdentity,
  type IntercomTag,
  type IntercomTeam,
} from "./intercom.js"
import {
  queryTicketsBySourceKey,
  resolveSyncedConversationPage,
  retrieveTicketDataSourceSchema,
  type NotionClientLike,
  type TicketDataSourceSchema,
  type TicketPageReference,
} from "./notion.js"
import type {
  InspectConversationInput,
  InspectConversationResult,
} from "./types.js"
import { EscalationError } from "./types.js"

const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

type IntercomGateway = Pick<
  IntercomClient,
  | "getIdentity"
  | "getTeam"
  | "getTag"
  | "getConversation"
  | "getContact"
  | "getCompany"
  | "addTag"
  | "routeToTeam"
  | "addInternalNote"
>

export interface EscalationDependencies {
  notion: NotionClientLike
  intercom: IntercomGateway
}

interface DeploymentContext {
  schema: TicketDataSourceSchema
  team: IntercomTeam
  tag: IntercomTag
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function sourceKey(workspaceId: string, conversationId: string): string {
  return `intercom:${workspaceId}:conversation:${conversationId}`
}

export function sortedTags(
  tags: IntercomTag[]
): { id: string; name: string }[] {
  return tags
    .map((tag) => ({ id: tag.id, name: tag.name }))
    .sort((left, right) =>
      left.id === right.id
        ? left.name.localeCompare(right.name)
        : left.id.localeCompare(right.id)
    )
}

/**
 * An inspection version is a freshness proof, not an idempotency key. It binds
 * the reviewed conversation to this Worker's fixed destination and route.
 */
export function conversationInspectionVersion(
  snapshot: ConversationSnapshot,
  config: RuntimeConfig,
  expectedTicketPageId: string | null = null
): string {
  return `iv1_${sha256(
    JSON.stringify({
      contract: "intercom-notion-ticket-inspection-v1",
      workspaceId: config.intercomWorkspaceId,
      conversationId: snapshot.id,
      destinationDataSourceId: config.notionTicketsDataSourceId,
      targetTeamId: config.intercomTeamId,
      targetTagId: config.intercomTagId,
      expectedTicketPageId: expectedTicketPageId
        ? expectedTicketPageId.replaceAll("-", "").toLowerCase()
        : null,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      state: snapshot.state,
      priority: snapshot.priority,
      title: snapshot.title,
      openingMessage: snapshot.openingMessage,
      contactIds: [...snapshot.contactIds].sort(),
      companyId: snapshot.companyId,
      teamAssigneeId: snapshot.teamAssigneeId,
      slaStatus: snapshot.slaStatus,
      tags: sortedTags(snapshot.tags),
      customerEvidence: snapshot.customerEvidence,
      evidenceTruncated: snapshot.evidenceTruncated,
      partsTruncated: snapshot.partsTruncated,
      internalNoteDigests: [...snapshot.internalNoteDigests].sort((a, b) =>
        a.partId.localeCompare(b.partId)
      ),
    })
  )}`
}

export function hasConfiguredTag(
  snapshot: ConversationSnapshot,
  config: RuntimeConfig
): boolean {
  return snapshot.tags.some((tag) => tag.id === config.intercomTagId)
}

export function hasNote(
  snapshot: ConversationSnapshot,
  digest: string
): boolean {
  return snapshot.internalNoteDigests.some((note) => note.digest === digest)
}

export function boundedText(
  value: unknown,
  label: string,
  maximum: number
): string {
  if (typeof value !== "string") {
    throw new EscalationError("INVALID_INPUT", `${label} must be text.`)
  }
  const normalized = value.replace(/\r\n?/g, "\n").trim()
  if (
    normalized.length < 1 ||
    normalized.length > maximum ||
    CONTROL_CHARACTER.test(normalized)
  ) {
    throw new EscalationError(
      "INVALID_INPUT",
      `${label} must contain 1–${maximum} characters of plain text.`
    )
  }
  return normalized
}

function assertConfiguredIdentity(
  identity: IntercomIdentity,
  config: RuntimeConfig
): void {
  if (
    identity.workspaceId !== config.intercomWorkspaceId ||
    identity.adminId !== config.intercomAdminId
  ) {
    throw new EscalationError(
      "INTERCOM_IDENTITY_MISMATCH",
      "The Intercom credential does not match the configured workspace and admin."
    )
  }
}

export async function inspectDeployment(
  config: RuntimeConfig,
  dependencies: EscalationDependencies
): Promise<DeploymentContext> {
  const [identity, team, tag, schema] = await Promise.all([
    dependencies.intercom.getIdentity(),
    dependencies.intercom.getTeam(config.intercomTeamId),
    dependencies.intercom.getTag(config.intercomTagId),
    retrieveTicketDataSourceSchema(
      dependencies.notion,
      config.notionTicketsDataSourceId
    ),
  ])
  assertConfiguredIdentity(identity, config)
  if (team.id !== config.intercomTeamId || tag.id !== config.intercomTagId) {
    throw new EscalationError(
      "INTERCOM_ROUTE_MISMATCH",
      "Intercom returned a different configured team or tag."
    )
  }
  return { schema, team, tag }
}

export function intercomConversationUrl(
  region: RuntimeConfig["intercomRegion"],
  workspaceId: string,
  conversationId: string
): string {
  return `${intercomAppBaseUrl(region)}/a/inbox/${encodeURIComponent(
    workspaceId
  )}/inbox/shared/all/conversation/${encodeURIComponent(conversationId)}`
}

function normalizeInspectionReference(
  input: InspectConversationInput,
  config: RuntimeConfig
): { conversationPageId: string | null; conversationId: string | null } {
  const conversationPageId =
    input.conversationPageId === null
      ? null
      : boundedText(input.conversationPageId, "conversationPageId", 2_000)
  const conversationId =
    input.conversationId === null
      ? null
      : normalizeIntercomConversationReference(input.conversationId, {
          region: config.intercomRegion,
          workspaceId: config.intercomWorkspaceId,
        })
  if ((conversationPageId === null) === (conversationId === null)) {
    throw new EscalationError(
      "INVALID_INPUT",
      "Provide exactly one of conversationPageId or conversationId."
    )
  }
  return { conversationPageId, conversationId }
}

export async function lookupDisplayContext(
  intercom: IntercomGateway,
  snapshot: ConversationSnapshot
): Promise<{
  customer: IntercomContact | null
  company: IntercomCompany | null
}> {
  const [customer, company] = await Promise.all([
    snapshot.contactIds[0]
      ? intercom.getContact(snapshot.contactIds[0])
      : Promise.resolve(null),
    snapshot.companyId
      ? intercom.getCompany(snapshot.companyId)
      : Promise.resolve(null),
  ])
  return { customer, company }
}

export function uniqueTicket(
  tickets: TicketPageReference[]
): TicketPageReference | null {
  if (tickets.length > 1) {
    throw new EscalationError(
      "DUPLICATE_NOTION_TICKETS",
      "More than one Notion ticket has the same Intercom source key. Resolve the duplicates before continuing.",
      "conflict"
    )
  }
  return tickets[0] ?? null
}

function noteMarker(key: string, pageId: string): string {
  const canonicalPageId = pageId.replaceAll("-", "").toLowerCase()
  return `icn_${sha256(`${key}:${canonicalPageId}`).slice(0, 32)}`
}

export function ticketNoteBody(key: string, pageId: string): string {
  const canonicalPageId = pageId.replaceAll("-", "").toLowerCase()
  return `Notion ticket: https://www.notion.so/${canonicalPageId}\nReference: ${noteMarker(
    key,
    pageId
  )}`
}

export async function inspectIntercomConversation(
  input: InspectConversationInput,
  config: RuntimeConfig,
  dependencies: EscalationDependencies
): Promise<InspectConversationResult> {
  const reference = normalizeInspectionReference(input, config)
  const [sourcePage, deployment] = await Promise.all([
    reference.conversationPageId
      ? resolveSyncedConversationPage(
          dependencies.notion,
          reference.conversationPageId
        )
      : Promise.resolve(null),
    inspectDeployment(config, dependencies),
  ])
  const conversationId = normalizeIntercomConversationReference(
    sourcePage?.conversationId ?? (reference.conversationId as string),
    {
      region: config.intercomRegion,
      workspaceId: config.intercomWorkspaceId,
    }
  )
  const snapshot = await dependencies.intercom.getConversation(conversationId)
  const key = sourceKey(config.intercomWorkspaceId, conversationId)
  const [display, tickets] = await Promise.all([
    lookupDisplayContext(dependencies.intercom, snapshot),
    queryTicketsBySourceKey(dependencies.notion, deployment.schema, key),
  ])
  const existing = uniqueTicket(tickets)
  const exactNotePresent = existing
    ? hasNote(
        snapshot,
        intercomNoteDigest(ticketNoteBody(key, existing.pageId))
      )
    : false
  const routeComplete = Boolean(
    existing &&
      snapshot.teamAssigneeId === config.intercomTeamId &&
      hasConfiguredTag(snapshot, config) &&
      exactNotePresent
  )

  return {
    conversationId,
    intercomUrl: intercomConversationUrl(
      config.intercomRegion,
      config.intercomWorkspaceId,
      conversationId
    ),
    sourcePageId: sourcePage?.pageId ?? null,
    sourcePageUrl: sourcePage?.pageUrl ?? null,
    inspectionVersion: conversationInspectionVersion(
      snapshot,
      config,
      existing?.pageId ?? null
    ),
    state: snapshot.state,
    priority: snapshot.priority,
    title: snapshot.title,
    openingMessage: snapshot.openingMessage,
    customer: display.customer,
    company: display.company,
    currentTeamId: snapshot.teamAssigneeId,
    slaStatus: snapshot.slaStatus,
    tags: snapshot.tags,
    evidence: snapshot.customerEvidence,
    evidenceTruncated: snapshot.evidenceTruncated,
    partsTruncated: snapshot.partsTruncated,
    existingTicket: existing
      ? { pageId: existing.pageId, url: existing.pageUrl }
      : null,
    ticketCreationState: existing ? "existing" : "none",
    plannedRoute: {
      teamId: deployment.team.id,
      teamName: deployment.team.name,
      tagId: deployment.tag.id,
      tagName: deployment.tag.name,
    },
    message: existing
      ? routeComplete
        ? "The Notion ticket and configured internal route are already complete. Show the existing ticket link."
        : snapshot.partsTruncated && !exactNotePresent
          ? "A Notion ticket exists, but the bounded Intercom history cannot prove whether its internal link note exists. Show the ticket and ask the user to verify the note in Intercom before attempting repair."
          : "A Notion ticket already exists. Show its link and, if the user confirms, reuse it to finish the configured internal route without overwriting the ticket."
      : "Draft and show the ticket to the user. Call createNotionTicket only after the user confirms it.",
  }
}
