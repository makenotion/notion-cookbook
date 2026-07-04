// One Sources database unifies top-level Reader documents with the source
// containers returned by Readwise's highlight export. Reader-backed export
// sources use the Reader document id, so highlights can relate to the richer
// Reader row without relying on titles or URLs as identity.

import { notionIcon } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

import type { ReaderDocument, ReadwiseSource } from "./readwise.js"
import {
  boundedText,
  dateValue,
  displayLabel,
  displayTitle,
  finiteNumber,
  normalizedCategory,
  readerTagNames,
  sourceName,
  trimmed,
  uniqueSelectNames,
  validDate,
  validUrl,
} from "./values.js"

export const SOURCES_INITIAL_TITLE = "Reading Sources"
export const SOURCES_PRIMARY_KEY = "Source Key"

export const sourceSchema = {
  databaseIcon: notionIcon("folder"),
  properties: {
    Source: Schema.title(),
    Location: Schema.select([
      { name: "Inbox", color: "blue" },
      { name: "Later", color: "yellow" },
      { name: "Shortlist", color: "green" },
      { name: "Archive", color: "gray" },
      { name: "Feed", color: "purple" },
    ]),
    "Reading Progress": Schema.number("percent"),
    Category: Schema.select([]),
    Author: Schema.richText(),
    Site: Schema.richText(),
    Tags: Schema.multiSelect([]),
    "Open in Reader": Schema.url(),
    Saved: Schema.date(),
    "Last Opened": Schema.date(),
    Summary: Schema.richText(),
    Note: Schema.richText(),
    Origin: Schema.select([]),
    Archived: Schema.checkbox(),
    "Reading Time": Schema.richText(),
    "Word Count": Schema.number(),
    Published: Schema.date(),
    Updated: Schema.date(),
    "Original URL": Schema.url(),
    "Readwise Review": Schema.url(),
    "Summary Truncated": Schema.checkbox(),
    "Note Truncated": Schema.checkbox(),
    "Reader Document ID": Schema.richText(),
    "Readwise Source ID": Schema.richText(),
    "Source Key": Schema.richText(),
  },
} satisfies Schema.Schema<typeof SOURCES_PRIMARY_KEY>

export function readerSourceKey(documentId: string): string {
  const id = documentId.trim()
  if (!id) throw new Error("Reader document id cannot be empty.")
  return `reader:${id}`
}

function isReaderSource(source: ReadwiseSource): boolean {
  return source.source?.trim().toLowerCase() === "reader"
}

export function readerExternalId(source: ReadwiseSource): string | undefined {
  return isReaderSource(source) ? trimmed(source.external_id) : undefined
}

export function exportSourceKey(source: ReadwiseSource): string {
  const externalId = readerExternalId(source)
  return externalId
    ? readerSourceKey(externalId)
    : `readwise:${source.user_book_id}`
}

function readwiseTagNames(source: ReadwiseSource): string[] {
  return uniqueSelectNames(source.book_tags.map((tag) => tag.name))
}

const READER_LOCATION_LABELS: Record<string, string> = {
  new: "Inbox",
  later: "Later",
  shortlist: "Shortlist",
  archive: "Archive",
  feed: "Feed",
}

function readerLocationLabel(value: string | undefined): string | undefined {
  return value
    ? (READER_LOCATION_LABELS[value] ?? displayLabel(value))
    : undefined
}

function categoryLabel(value: string | undefined): string | undefined {
  return displayLabel(value)
}

export function readerDocumentToChange(
  document: ReaderDocument,
  options: { exportPresent?: boolean } = {}
) {
  // Reader also models its highlights and notes as documents. parent_id is the
  // documented discriminator; those records come from Readwise Export instead.
  if (document.parent_id !== null) return undefined

  const key = readerSourceKey(document.id)
  const summary = boundedText(document.summary)
  const note = boundedText(document.notes)
  const category = categoryLabel(normalizedCategory(document.category))
  const rawLocation = trimmed(document.location)?.toLowerCase()
  const location = readerLocationLabel(rawLocation)
  const progress = finiteNumber(document.reading_progress)
  const wordCount = finiteNumber(document.word_count)
  const updatedAt = validDate(document.updated_at)

  return {
    type: "upsert" as const,
    key,
    ...(updatedAt ? { upstreamUpdatedAt: updatedAt } : {}),
    properties: {
      Source: Builder.title(
        displayTitle(document.title, `Untitled Reader document ${document.id}`)
      ),
      Location: location ? Builder.select(location) : [],
      "Reading Progress":
        progress !== undefined && progress >= 0 && progress <= 1
          ? Builder.number(progress)
          : [],
      Category: category ? Builder.select(category) : [],
      Author: trimmed(document.author)
        ? Builder.richText(document.author!.trim())
        : [],
      Site: trimmed(document.site_name)
        ? Builder.richText(document.site_name!.trim())
        : [],
      Tags: Builder.multiSelect(...readerTagNames(document.tags)),
      "Open in Reader": validUrl(document.url)
        ? Builder.url(validUrl(document.url)!)
        : [],
      Saved: dateValue(document.saved_at),
      "Last Opened": dateValue(document.last_opened_at),
      Summary: summary.text ? Builder.richText(summary.text) : [],
      Note: note.text ? Builder.richText(note.text) : [],
      Origin: Builder.select("Reader"),
      Archived: Builder.checkbox(rawLocation === "archive"),
      "Reading Time": trimmed(document.reading_time)
        ? Builder.richText(document.reading_time!.trim())
        : [],
      "Word Count":
        wordCount !== undefined && wordCount >= 0
          ? Builder.number(wordCount)
          : [],
      Published: dateValue(document.published_date),
      Updated: dateValue(document.updated_at),
      "Original URL": validUrl(document.source_url)
        ? Builder.url(validUrl(document.source_url)!)
        : [],
      ...(options.exportPresent === false
        ? {
            "Readwise Review": [],
          }
        : {}),
      "Summary Truncated": Builder.checkbox(summary.truncated),
      "Note Truncated": Builder.checkbox(note.truncated),
      "Reader Document ID": Builder.richText(document.id),
      ...(options.exportPresent === false
        ? {
            "Readwise Source ID": [],
          }
        : {}),
      "Source Key": Builder.richText(key),
    },
  }
}

function exportOwnedProperties(source: ReadwiseSource) {
  const reviewUrl = validUrl(source.readwise_url)
  return {
    "Readwise Review": reviewUrl ? Builder.url(reviewUrl) : [],
    "Readwise Source ID": Builder.richText(source.user_book_id),
  }
}

function fullExportProperties(source: ReadwiseSource) {
  const key = exportSourceKey(source)
  const summary = boundedText(source.summary)
  const note = boundedText(source.document_note)
  const category = categoryLabel(normalizedCategory(source.category))
  const readerId = readerExternalId(source)
  const title = trimmed(source.readable_title) ?? trimmed(source.title)
  const originalUrl = validUrl(source.source_url) ?? validUrl(source.unique_url)
  const exportOwned = exportOwnedProperties(source)

  return {
    Source: Builder.title(
      displayTitle(title, `Untitled Readwise source ${source.user_book_id}`)
    ),
    Location: [],
    "Reading Progress": [],
    Category: category ? Builder.select(category) : [],
    Author: trimmed(source.author)
      ? Builder.richText(source.author!.trim())
      : [],
    Site: [],
    Tags: Builder.multiSelect(...readwiseTagNames(source)),
    "Open in Reader": [],
    Saved: [],
    "Last Opened": [],
    Summary: summary.text ? Builder.richText(summary.text) : [],
    Note: note.text ? Builder.richText(note.text) : [],
    Origin: Builder.select(sourceName(source.source)),
    Archived: Builder.checkbox(false),
    "Reading Time": [],
    "Word Count": [],
    Published: [],
    Updated: [],
    "Original URL": originalUrl ? Builder.url(originalUrl) : [],
    "Readwise Review": exportOwned["Readwise Review"],
    "Summary Truncated": Builder.checkbox(summary.truncated),
    "Note Truncated": Builder.checkbox(note.truncated),
    "Reader Document ID": readerId ? Builder.richText(readerId) : [],
    "Readwise Source ID": exportOwned["Readwise Source ID"],
    "Source Key": Builder.richText(key),
  }
}

export function exportSourceToChange(
  source: ReadwiseSource,
  options: { initialBackfill?: boolean } = {}
) {
  const key = exportSourceKey(source)
  const readerId = readerExternalId(source)
  // Reader LIST owns unified reader:<id> rows. An Export tombstone cannot prove
  // that the Reader document disappeared, so the replacement sync resolves it.
  if (source.is_deleted) {
    return readerId ? undefined : { type: "delete" as const, key }
  }

  // On the initial full-history cycle, Reader's own full-history phase follows
  // Export and deterministically restores its owned fields. Later Export-only
  // deltas use a narrow patch so an unchanged Reader parent cannot be clobbered.
  if (readerId && !options.initialBackfill) {
    return {
      type: "upsert" as const,
      key,
      properties: {
        ...exportOwnedProperties(source),
        "Reader Document ID": Builder.richText(readerId),
        "Source Key": Builder.richText(key),
      },
    }
  }

  return {
    type: "upsert" as const,
    key,
    properties: fullExportProperties(source),
  }
}

export function exportSourceToReconciliationChange(
  source: ReadwiseSource,
  readerPresent: boolean
) {
  if (source.is_deleted) {
    throw new Error(
      "Readwise reconciliation unexpectedly returned a deleted source."
    )
  }
  const key = exportSourceKey(source)
  const readerId = readerExternalId(source)
  if (readerId && readerPresent) {
    return {
      type: "upsert" as const,
      key,
      properties: {
        ...exportOwnedProperties(source),
        "Reader Document ID": Builder.richText(readerId),
        "Source Key": Builder.richText(key),
      },
    }
  }
  return {
    type: "upsert" as const,
    key,
    properties: fullExportProperties(source),
  }
}
