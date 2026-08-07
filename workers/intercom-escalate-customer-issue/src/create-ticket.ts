import { createHash } from "node:crypto"
import type { RuntimeConfig } from "./config.js"
import {
  intercomNoteDigest,
  isDefiniteIntercomMutationRejection,
  normalizeIntercomConversationReference,
  type ConversationSnapshot,
} from "./intercom.js"
import {
  createTicketPage,
  NotionAdapterError,
  NotionCreateError,
  queryTicketsBySourceKey,
  retrieveAndVerifyTicketPage,
  type NotionClientLike,
  type TicketDataSourceSchema,
  type TicketPageReference,
} from "./notion.js"
import {
  boundedText,
  conversationInspectionVersion,
  hasConfiguredTag,
  hasNote,
  inspectDeployment,
  intercomConversationUrl,
  lookupDisplayContext,
  sortedTags,
  sourceKey,
  ticketNoteBody,
  uniqueTicket,
  type EscalationDependencies,
} from "./inspect-conversation.js"
import type {
  CreateTicketInput,
  CreateTicketResult,
  TicketDraft,
} from "./types.js"
import { EscalationError } from "./types.js"

const INSPECTION_VERSION = /^iv1_[0-9a-f]{64}$/

interface NormalizedCreateInput {
  conversationId: string
  inspectionVersion: string
  ticketDraft: TicketDraft | null
}

interface CreateProgress {
  conversationId: string
  ticket: CreateTicketResult["ticket"]
  intercom: CreateTicketResult["intercom"]
  knownChanged: boolean
  uncertainWrite: boolean
}

interface ExpectedLiveState {
  continuityVersion: string
  teamId: string | null
  tagPresent: boolean
  notePresent: boolean
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function sameNotionPageId(left: string, right: string): boolean {
  return (
    left.replaceAll("-", "").toLowerCase() ===
    right.replaceAll("-", "").toLowerCase()
  )
}

function continuityVersion(
  snapshot: ConversationSnapshot,
  config: RuntimeConfig,
  desiredNoteDigest: string
): string {
  return sha256(
    JSON.stringify({
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      state: snapshot.state,
      priority: snapshot.priority,
      title: snapshot.title,
      openingMessage: snapshot.openingMessage,
      contactIds: [...snapshot.contactIds].sort(),
      companyId: snapshot.companyId,
      slaStatus: snapshot.slaStatus,
      tags: sortedTags(
        snapshot.tags.filter((tag) => tag.id !== config.intercomTagId)
      ),
      customerEvidence: snapshot.customerEvidence,
      evidenceTruncated: snapshot.evidenceTruncated,
      partsTruncated: snapshot.partsTruncated,
      internalNoteDigests: snapshot.internalNoteDigests
        .filter((note) => note.digest !== desiredNoteDigest)
        .sort((a, b) => a.partId.localeCompare(b.partId)),
    })
  )
}

function expectedLiveState(
  snapshot: ConversationSnapshot,
  config: RuntimeConfig,
  desiredNoteDigest: string
): ExpectedLiveState {
  return {
    continuityVersion: continuityVersion(snapshot, config, desiredNoteDigest),
    teamId: snapshot.teamAssigneeId,
    tagPresent: hasConfiguredTag(snapshot, config),
    notePresent: hasNote(snapshot, desiredNoteDigest),
  }
}

function assertExpectedLiveState(
  snapshot: ConversationSnapshot,
  expected: ExpectedLiveState,
  config: RuntimeConfig,
  desiredNoteDigest: string
): void {
  if (
    continuityVersion(snapshot, config, desiredNoteDigest) !==
      expected.continuityVersion ||
    snapshot.teamAssigneeId !== expected.teamId ||
    hasConfiguredTag(snapshot, config) !== expected.tagPresent ||
    hasNote(snapshot, desiredNoteDigest) !== expected.notePresent
  ) {
    throw new EscalationError(
      "CONVERSATION_CHANGED",
      "The Intercom conversation changed during the action. Inspect it again before deciding whether to continue.",
      "conflict"
    )
  }
}

function assertInspectionVersion(
  snapshot: ConversationSnapshot,
  version: string,
  config: RuntimeConfig,
  expectedTicketPageId: string | null
): void {
  if (
    conversationInspectionVersion(snapshot, config, expectedTicketPageId) !==
    version
  ) {
    throw new EscalationError(
      "CONVERSATION_CHANGED",
      "The Intercom conversation changed after inspection. Inspect it again before creating or routing a ticket.",
      "conflict"
    )
  }
}
function nullableText(
  value: unknown,
  label: string,
  maximum: number
): string | null {
  if (value === null) return null
  return boundedText(value, label, maximum)
}

function normalizeTicketDraft(value: TicketDraft | null): TicketDraft | null {
  if (value === null) return null
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EscalationError(
      "INVALID_INPUT",
      "ticketDraft must be a reviewed ticket draft or null."
    )
  }
  if (
    !(
      value.priority === "P0" ||
      value.priority === "P1" ||
      value.priority === "P2" ||
      value.priority === "P3"
    )
  ) {
    throw new EscalationError(
      "INVALID_INPUT",
      "ticketDraft.priority must be P0, P1, P2, or P3."
    )
  }
  if (
    !Array.isArray(value.reproductionSteps) ||
    value.reproductionSteps.length > 12
  ) {
    throw new EscalationError(
      "INVALID_INPUT",
      "ticketDraft.reproductionSteps must contain at most 12 steps."
    )
  }
  return {
    title: boundedText(value.title, "ticketDraft.title", 200),
    priority: value.priority,
    summary: boundedText(value.summary, "ticketDraft.summary", 2_000),
    impact: boundedText(value.impact, "ticketDraft.impact", 4_000),
    environment: nullableText(
      value.environment,
      "ticketDraft.environment",
      2_000
    ),
    reproductionSteps: value.reproductionSteps.map((step) =>
      boundedText(step, "ticketDraft.reproductionSteps item", 1_000)
    ),
  }
}

function normalizeCreateInput(
  input: CreateTicketInput,
  config: RuntimeConfig
): NormalizedCreateInput {
  if (
    typeof input.inspectionVersion !== "string" ||
    !INSPECTION_VERSION.test(input.inspectionVersion)
  ) {
    throw new EscalationError(
      "INVALID_INPUT",
      "inspectionVersion must be the exact opaque value returned by inspection."
    )
  }
  return {
    conversationId: normalizeIntercomConversationReference(
      input.conversationId,
      {
        region: config.intercomRegion,
        workspaceId: config.intercomWorkspaceId,
      }
    ),
    inspectionVersion: input.inspectionVersion,
    ticketDraft: normalizeTicketDraft(input.ticketDraft),
  }
}
function changed(progress: CreateProgress): boolean | null {
  if (progress.knownChanged) return true
  return progress.uncertainWrite ? null : false
}

function completedResult(progress: CreateProgress): CreateTicketResult {
  const didChange = changed(progress)
  return {
    ok: true,
    status: didChange === false ? "no_op" : "completed",
    changed: didChange,
    conversationId: progress.conversationId,
    ticket: progress.ticket,
    intercom: progress.intercom,
    customerVisibleReplySent: false,
    retryable: false,
    nextStep: null,
    message:
      didChange === false
        ? "The Notion ticket and internal Intercom route were already complete."
        : progress.ticket.action === "existing"
          ? "The existing Notion ticket was reused without overwriting it, and the internal Intercom route is complete."
          : "The Notion ticket and internal Intercom route are complete.",
  }
}

function isExpectedError(
  error: unknown
): error is EscalationError | NotionAdapterError {
  return error instanceof EscalationError || error instanceof NotionAdapterError
}

function nextStepFor(error: EscalationError | NotionAdapterError): string {
  if (error.code === "NOTION_CREATE_OUTCOME_UNKNOWN") {
    return "Search the configured Notion data source for this conversation's exact Intercom source key. Do not issue another create until the first outcome is resolved."
  }
  if (
    error.code === "INTERCOM_NOTE_OUTCOME_UNKNOWN" ||
    error.code === "INTERCOM_NOTE_NOT_VISIBLE"
  ) {
    return "Open the Intercom conversation and verify the exact Notion ticket-link note manually. Do not post a replacement automatically."
  }
  if (
    error.code === "INTERCOM_MUTATION_OUTCOME_UNKNOWN" ||
    error.code === "INTERCOM_POSTCONDITION_FAILED"
  ) {
    return "Inspect the conversation again and review its live tag and team before deciding whether to continue."
  }
  if (
    error.code === "CONVERSATION_CHANGED" ||
    error.code === "NOTION_TICKET_STATE_CHANGED"
  ) {
    return "Inspect the conversation again and ask the user to review the new live state."
  }
  if (
    error.code === "DUPLICATE_NOTION_TICKETS" ||
    error.code === "NOTION_QUERY_NOT_UNIQUE" ||
    error.code === "NOTION_TICKET_MISMATCH"
  ) {
    return "Resolve the conflicting Notion tickets manually before running this action again."
  }
  if (error.code === "TICKET_DRAFT_REQUIRED") {
    return "Inspect the conversation, draft the ticket, and ask the user to approve it before creating anything."
  }
  if (error.code === "NOTION_CREATE_REJECTED" && error.retryable) {
    return "Wait for Notion to recover, inspect the conversation again, then retry with the newly reviewed inspection version."
  }
  return "Check the configured credentials, permissions, IDs, and Notion ticket schema, then inspect the conversation again."
}

function failureResult(
  error: EscalationError | NotionAdapterError,
  progress: CreateProgress
): CreateTicketResult {
  let status: CreateTicketResult["status"] =
    error instanceof EscalationError ? error.status : "blocked"
  if (error.code === "NOTION_QUERY_NOT_UNIQUE") status = "conflict"
  if (progress.ticket.pageId && status === "blocked") status = "partial_failure"
  const exactRetryIsSafe =
    error.retryable && !progress.knownChanged && !progress.uncertainWrite
  return {
    ok: false,
    status,
    changed: changed(progress),
    conversationId: progress.conversationId,
    ticket: progress.ticket,
    intercom: progress.intercom,
    customerVisibleReplySent: false,
    retryable: exactRetryIsSafe,
    nextStep: nextStepFor(error),
    message: error.message,
  }
}

async function readAfterIntercomMutation(
  dependencies: EscalationDependencies,
  conversationId: string,
  progress: CreateProgress,
  action: keyof CreateTicketResult["intercom"]
): Promise<ConversationSnapshot> {
  try {
    return await dependencies.intercom.getConversation(conversationId)
  } catch (error) {
    if (!isExpectedError(error)) throw error
    progress.intercom[action] = "unknown"
    throw new EscalationError(
      action === "note"
        ? "INTERCOM_NOTE_OUTCOME_UNKNOWN"
        : "INTERCOM_MUTATION_OUTCOME_UNKNOWN",
      action === "note"
        ? "Intercom may have added the internal ticket-link note, but its live state could not be read."
        : `Intercom may have applied the ${action}, but its live state could not be read.`,
      "ambiguous",
      false,
      true
    )
  }
}

async function reconcileUnknownNotionCreate(
  notion: NotionClientLike,
  schema: TicketDataSourceSchema,
  key: string,
  expectedPageId: string | null
): Promise<TicketPageReference> {
  let tickets: TicketPageReference[]
  try {
    tickets = await queryTicketsBySourceKey(notion, schema, key)
  } catch {
    throw new EscalationError(
      "NOTION_CREATE_OUTCOME_UNKNOWN",
      "Notion may have created the ticket, but the exact source-key lookup could not prove the outcome.",
      "ambiguous",
      false,
      true
    )
  }
  const ticket = uniqueTicket(tickets)
  if (
    ticket &&
    expectedPageId &&
    !sameNotionPageId(ticket.pageId, expectedPageId)
  ) {
    throw new EscalationError(
      "NOTION_TICKET_MISMATCH",
      "Notion source-key lookup returned a different ticket than the page identified by the create response.",
      "conflict"
    )
  }
  if (!ticket) {
    throw new EscalationError(
      "NOTION_CREATE_OUTCOME_UNKNOWN",
      "Notion may have created the ticket, but no exact source-key match is visible yet.",
      "ambiguous",
      false,
      true
    )
  }
  return ticket
}

async function confirmSoleCreatedTicket(
  notion: NotionClientLike,
  schema: TicketDataSourceSchema,
  key: string,
  created: TicketPageReference
): Promise<void> {
  let tickets: TicketPageReference[]
  try {
    tickets = await queryTicketsBySourceKey(notion, schema, key)
  } catch {
    throw new EscalationError(
      "NOTION_CREATE_OUTCOME_UNKNOWN",
      "Notion created the ticket, but the Worker could not prove that it is the sole exact source-key match.",
      "ambiguous",
      false,
      true
    )
  }
  const unique = uniqueTicket(tickets)
  if (!unique || !sameNotionPageId(unique.pageId, created.pageId)) {
    throw new EscalationError(
      unique ? "NOTION_TICKET_MISMATCH" : "NOTION_CREATE_OUTCOME_UNKNOWN",
      unique
        ? "Notion source-key lookup returned a different ticket after creation."
        : "Notion created the ticket, but its exact source-key match is not visible yet.",
      unique ? "conflict" : "ambiguous",
      false,
      !unique
    )
  }
}

async function assertSoleTicket(
  notion: NotionClientLike,
  schema: TicketDataSourceSchema,
  key: string,
  expected: TicketPageReference
): Promise<void> {
  const live = uniqueTicket(await queryTicketsBySourceKey(notion, schema, key))
  if (!live || !sameNotionPageId(live.pageId, expected.pageId)) {
    throw new EscalationError(
      "NOTION_TICKET_MISMATCH",
      "The expected Notion ticket is not the sole exact source-key match.",
      "conflict"
    )
  }
}

async function ensureTag(
  snapshot: ConversationSnapshot,
  expected: ExpectedLiveState,
  desiredNoteDigest: string,
  config: RuntimeConfig,
  dependencies: EscalationDependencies,
  progress: CreateProgress
): Promise<{ snapshot: ConversationSnapshot; expected: ExpectedLiveState }> {
  assertExpectedLiveState(snapshot, expected, config, desiredNoteDigest)
  if (expected.tagPresent) {
    progress.intercom.tag = "unchanged"
    return { snapshot, expected }
  }

  let responseConfirmed = false
  try {
    await dependencies.intercom.addTag(snapshot.id, config.intercomTagId)
    responseConfirmed = true
    progress.knownChanged = true
  } catch (error) {
    if (!isExpectedError(error) || isDefiniteIntercomMutationRejection(error)) {
      throw error
    }
    if (!(error instanceof EscalationError) || !error.ambiguous) throw error
    progress.uncertainWrite = true
  }

  const refreshed = await readAfterIntercomMutation(
    dependencies,
    snapshot.id,
    progress,
    "tag"
  )
  const nextExpected: ExpectedLiveState = {
    ...expected,
    tagPresent: true,
    notePresent: expected.notePresent || hasNote(refreshed, desiredNoteDigest),
  }
  if (!hasConfiguredTag(refreshed, config)) {
    progress.intercom.tag = "unknown"
    throw new EscalationError(
      "INTERCOM_MUTATION_OUTCOME_UNKNOWN",
      "Intercom did not prove that the configured escalation tag is present.",
      "ambiguous",
      false,
      true
    )
  }
  assertExpectedLiveState(refreshed, nextExpected, config, desiredNoteDigest)
  if (!responseConfirmed) progress.uncertainWrite = true
  progress.intercom.tag = "applied"
  return { snapshot: refreshed, expected: nextExpected }
}

async function ensureRoute(
  snapshot: ConversationSnapshot,
  expected: ExpectedLiveState,
  desiredNoteDigest: string,
  config: RuntimeConfig,
  dependencies: EscalationDependencies,
  progress: CreateProgress
): Promise<{ snapshot: ConversationSnapshot; expected: ExpectedLiveState }> {
  assertExpectedLiveState(snapshot, expected, config, desiredNoteDigest)
  if (expected.teamId === config.intercomTeamId) {
    progress.intercom.route = "unchanged"
    return { snapshot, expected }
  }

  let responseConfirmed = false
  try {
    await dependencies.intercom.routeToTeam(snapshot.id, config.intercomTeamId)
    responseConfirmed = true
    progress.knownChanged = true
  } catch (error) {
    if (!isExpectedError(error) || isDefiniteIntercomMutationRejection(error)) {
      throw error
    }
    if (!(error instanceof EscalationError) || !error.ambiguous) throw error
    progress.uncertainWrite = true
  }

  const refreshed = await readAfterIntercomMutation(
    dependencies,
    snapshot.id,
    progress,
    "route"
  )
  const nextExpected: ExpectedLiveState = {
    ...expected,
    teamId: config.intercomTeamId,
    notePresent: expected.notePresent || hasNote(refreshed, desiredNoteDigest),
  }
  if (refreshed.teamAssigneeId !== config.intercomTeamId) {
    progress.intercom.route = "unknown"
    throw new EscalationError(
      "INTERCOM_MUTATION_OUTCOME_UNKNOWN",
      "Intercom did not prove that the conversation reached the configured team.",
      "ambiguous",
      false,
      true
    )
  }
  assertExpectedLiveState(refreshed, nextExpected, config, desiredNoteDigest)
  if (!responseConfirmed) progress.uncertainWrite = true
  progress.intercom.route = "applied"
  return { snapshot: refreshed, expected: nextExpected }
}

async function ensureNote(
  snapshot: ConversationSnapshot,
  expected: ExpectedLiveState,
  body: string,
  desiredNoteDigest: string,
  allowFirstNoteWhenHistoryIsTruncated: boolean,
  config: RuntimeConfig,
  dependencies: EscalationDependencies,
  progress: CreateProgress
): Promise<{ snapshot: ConversationSnapshot; expected: ExpectedLiveState }> {
  assertExpectedLiveState(snapshot, expected, config, desiredNoteDigest)
  if (expected.notePresent) {
    progress.intercom.note = "unchanged"
    return { snapshot, expected }
  }
  if (snapshot.partsTruncated && !allowFirstNoteWhenHistoryIsTruncated) {
    progress.intercom.note = "unknown"
    throw new EscalationError(
      "INTERCOM_NOTE_NOT_VISIBLE",
      "Intercom omitted older conversation parts, so the Worker cannot prove that the exact ticket-link note is absent.",
      "ambiguous",
      false,
      true
    )
  }

  let responseConfirmed = false
  try {
    await dependencies.intercom.addInternalNote(snapshot.id, body)
    responseConfirmed = true
    progress.knownChanged = true
  } catch (error) {
    if (!isExpectedError(error) || isDefiniteIntercomMutationRejection(error)) {
      throw error
    }
    if (!(error instanceof EscalationError) || !error.ambiguous) throw error
    progress.uncertainWrite = true
  }

  const refreshed = await readAfterIntercomMutation(
    dependencies,
    snapshot.id,
    progress,
    "note"
  )
  const nextExpected: ExpectedLiveState = {
    ...expected,
    notePresent: true,
  }
  if (!hasNote(refreshed, desiredNoteDigest)) {
    progress.intercom.note = "unknown"
    throw new EscalationError(
      "INTERCOM_NOTE_OUTCOME_UNKNOWN",
      "Intercom may have added the internal ticket-link note, but the exact note is not visible.",
      "ambiguous",
      false,
      true
    )
  }
  assertExpectedLiveState(refreshed, nextExpected, config, desiredNoteDigest)
  if (!responseConfirmed) progress.uncertainWrite = true
  progress.intercom.note = "applied"
  return { snapshot: refreshed, expected: nextExpected }
}

async function createNotionTicketCore(
  input: NormalizedCreateInput,
  config: RuntimeConfig,
  dependencies: EscalationDependencies,
  progress: CreateProgress
): Promise<CreateTicketResult> {
  const deployment = await inspectDeployment(config, dependencies)
  const key = sourceKey(config.intercomWorkspaceId, input.conversationId)
  let snapshot = await dependencies.intercom.getConversation(
    input.conversationId
  )
  let ticket = uniqueTicket(
    await queryTicketsBySourceKey(dependencies.notion, deployment.schema, key)
  )
  const reviewedTicketPageId = ticket?.pageId ?? null
  assertInspectionVersion(
    snapshot,
    input.inspectionVersion,
    config,
    reviewedTicketPageId
  )
  if (ticket) {
    progress.ticket = {
      pageId: ticket.pageId,
      url: ticket.pageUrl,
      action: "existing",
    }
  } else {
    if (!input.ticketDraft) {
      throw new EscalationError(
        "TICKET_DRAFT_REQUIRED",
        "No Notion ticket exists, so a reviewed ticketDraft is required before creation."
      )
    }

    const display = await lookupDisplayContext(dependencies.intercom, snapshot)
    snapshot = await dependencies.intercom.getConversation(input.conversationId)
    assertInspectionVersion(
      snapshot,
      input.inspectionVersion,
      config,
      reviewedTicketPageId
    )
    if (
      uniqueTicket(
        await queryTicketsBySourceKey(
          dependencies.notion,
          deployment.schema,
          key
        )
      )
    ) {
      throw new EscalationError(
        "NOTION_TICKET_STATE_CHANGED",
        "A Notion ticket appeared after inspection. Inspect the conversation again and review that ticket before routing it.",
        "conflict"
      )
    }
    try {
      ticket = await createTicketPage(dependencies.notion, {
        schema: deployment.schema,
        sourceKey: key,
        title: input.ticketDraft.title,
        priority: input.ticketDraft.priority,
        customer: display.customer?.name ?? display.customer?.id ?? null,
        company: display.company?.name ?? display.company?.id ?? null,
        intercomUpdatedAt: new Date(snapshot.updatedAt * 1_000).toISOString(),
        body: {
          summary: input.ticketDraft.summary,
          impact: input.ticketDraft.impact,
          environment: input.ticketDraft.environment,
          reproductionSteps: input.ticketDraft.reproductionSteps,
          evidence: [
            ...(snapshot.openingMessage
              ? [`Opening message: ${snapshot.openingMessage}`]
              : []),
            ...snapshot.customerEvidence.map(
              (item) =>
                `${new Date(item.createdAt * 1_000).toISOString()} (${item.role}): ${item.text}`
            ),
          ],
          intercomUrl: intercomConversationUrl(
            config.intercomRegion,
            config.intercomWorkspaceId,
            input.conversationId
          ),
        },
      })
      progress.ticket = {
        pageId: ticket.pageId,
        url: ticket.pageUrl,
        action: "unknown",
      }
      progress.knownChanged = true
      await confirmSoleCreatedTicket(
        dependencies.notion,
        deployment.schema,
        key,
        ticket
      )
      progress.ticket.action = "created"
    } catch (error) {
      if (!(error instanceof NotionCreateError)) throw error
      if (error.disposition === "definite_rejection") throw error
      progress.ticket.action = "unknown"
      progress.uncertainWrite = true
      if (error.pageId) {
        try {
          const hintedTicket = await retrieveAndVerifyTicketPage(
            dependencies.notion,
            deployment.schema,
            error.pageId,
            key
          )
          progress.ticket = {
            pageId: hintedTicket.pageId,
            url: hintedTicket.pageUrl,
            action: "unknown",
          }
        } catch (recoveryError) {
          if (
            recoveryError instanceof NotionAdapterError &&
            recoveryError.code === "NOTION_TICKET_MISMATCH"
          ) {
            throw recoveryError
          }
        }
      }
      ticket = await reconcileUnknownNotionCreate(
        dependencies.notion,
        deployment.schema,
        key,
        error.pageId
      )
      progress.ticket = {
        pageId: ticket.pageId,
        url: ticket.pageUrl,
        action: "unknown",
      }
    }
  }

  await assertSoleTicket(dependencies.notion, deployment.schema, key, ticket)
  snapshot = await dependencies.intercom.getConversation(input.conversationId)
  assertInspectionVersion(
    snapshot,
    input.inspectionVersion,
    config,
    reviewedTicketPageId
  )

  const body = ticketNoteBody(key, ticket.pageId)
  const desiredNoteDigest = intercomNoteDigest(body)
  let expected = expectedLiveState(snapshot, config, desiredNoteDigest)
  if (
    snapshot.partsTruncated &&
    !expected.notePresent &&
    progress.ticket.action !== "created"
  ) {
    progress.intercom.note = "unknown"
    throw new EscalationError(
      "INTERCOM_NOTE_NOT_VISIBLE",
      "Intercom omitted older conversation parts, so the Worker cannot prove that the exact ticket-link note is absent.",
      "ambiguous",
      false,
      true
    )
  }

  const tagState = await ensureTag(
    snapshot,
    expected,
    desiredNoteDigest,
    config,
    dependencies,
    progress
  )
  snapshot = tagState.snapshot
  expected = tagState.expected

  const routeState = await ensureRoute(
    snapshot,
    expected,
    desiredNoteDigest,
    config,
    dependencies,
    progress
  )
  snapshot = routeState.snapshot
  expected = routeState.expected

  const noteState = await ensureNote(
    snapshot,
    expected,
    body,
    desiredNoteDigest,
    progress.ticket.action === "created",
    config,
    dependencies,
    progress
  )
  expected = noteState.expected

  const final = await dependencies.intercom.getConversation(
    input.conversationId
  )
  assertExpectedLiveState(final, expected, config, desiredNoteDigest)
  if (
    !hasConfiguredTag(final, config) ||
    final.teamAssigneeId !== config.intercomTeamId ||
    !hasNote(final, desiredNoteDigest)
  ) {
    throw new EscalationError(
      "INTERCOM_POSTCONDITION_FAILED",
      "Intercom did not preserve every configured postcondition through the final read.",
      "ambiguous",
      false,
      true
    )
  }
  await assertSoleTicket(dependencies.notion, deployment.schema, key, ticket)

  return completedResult(progress)
}

export async function createNotionTicket(
  rawInput: CreateTicketInput,
  config: RuntimeConfig,
  dependencies: EscalationDependencies
): Promise<CreateTicketResult> {
  const progress: CreateProgress = {
    conversationId:
      typeof rawInput.conversationId === "string"
        ? rawInput.conversationId.slice(0, 100)
        : "invalid",
    ticket: { pageId: null, url: null, action: "none" },
    intercom: { tag: "pending", route: "pending", note: "pending" },
    knownChanged: false,
    uncertainWrite: false,
  }
  try {
    const input = normalizeCreateInput(rawInput, config)
    progress.conversationId = input.conversationId
    return await createNotionTicketCore(input, config, dependencies, progress)
  } catch (error) {
    if (!isExpectedError(error)) throw error
    return failureResult(error, progress)
  }
}

export function configurationFailure(
  conversationId: string,
  error: unknown
): CreateTicketResult {
  const message =
    error instanceof Error
      ? error.message.replace(/[^\x20-\x7e]/g, " ").slice(0, 300)
      : "Worker configuration is invalid."
  return {
    ok: false,
    status: "blocked",
    changed: false,
    conversationId: conversationId.slice(0, 100),
    ticket: { pageId: null, url: null, action: "none" },
    intercom: { tag: "pending", route: "pending", note: "pending" },
    customerVisibleReplySent: false,
    retryable: false,
    nextStep:
      "Fix the Worker environment configuration, then inspect the conversation again.",
    message,
  }
}
