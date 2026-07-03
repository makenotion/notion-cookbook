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
    Name: Schema.title(),
    Origin: Schema.select([]),
    Category: Schema.select([]),
    Location: Schema.select([
      { name: "new" },
      { name: "later" },
      { name: "shortlist" },
      { name: "archive" },
      { name: "feed" },
    ]),
    Archived: Schema.checkbox(),
    Author: Schema.richText(),
    Site: Schema.richText(),
    Tags: Schema.multiSelect([]),
    "Original URL": Schema.url(),
    "Open in Reader": Schema.url(),
    "Readwise Review": Schema.url(),
    Summary: Schema.richText(),
    "Summary Truncated": Schema.checkbox(),
    Note: Schema.richText(),
    "Note Truncated": Schema.checkbox(),
    "Reading Progress": Schema.number(),
    "Word Count": Schema.number(),
    "Reading Time": Schema.richText(),
    Published: Schema.date(),
    Saved: Schema.date(),
    "Last Opened": Schema.date(),
    Updated: Schema.date(),
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

export function exportSourceKey(source: ReadwiseSource): string {
  const externalId = trimmed(source.external_id)
  return isReaderSource(source) && externalId
    ? readerSourceKey(externalId)
    : `readwise:${source.user_book_id}`
}

function readwiseTagNames(source: ReadwiseSource): string[] {
  return uniqueSelectNames(source.book_tags.map((tag) => tag.name))
}

export function readerDocumentToChange(document: ReaderDocument) {
  // Reader also models its highlights and notes as documents. parent_id is the
  // documented discriminator; those records come from Readwise Export instead.
  if (document.parent_id !== null) return undefined

  const key = readerSourceKey(document.id)
  const summary = boundedText(document.summary)
  const note = boundedText(document.notes)
  const category = normalizedCategory(document.category)
  const location = trimmed(document.location)?.toLowerCase()
  const progress = finiteNumber(document.reading_progress)
  const wordCount = finiteNumber(document.word_count)
  const updatedAt = validDate(document.updated_at)

  return {
    type: "upsert" as const,
    key,
    ...(updatedAt ? { upstreamUpdatedAt: updatedAt } : {}),
    properties: {
      Name: Builder.title(
        displayTitle(document.title, `Untitled Reader document ${document.id}`)
      ),
      Origin: Builder.select("Reader"),
      Category: category ? Builder.select(category) : [],
      Location: location ? Builder.select(location) : [],
      Archived: Builder.checkbox(location === "archive"),
      Author: trimmed(document.author)
        ? Builder.richText(document.author!.trim())
        : [],
      Site: trimmed(document.site_name)
        ? Builder.richText(document.site_name!.trim())
        : [],
      Tags: Builder.multiSelect(...readerTagNames(document.tags)),
      "Original URL": validUrl(document.source_url)
        ? Builder.url(validUrl(document.source_url)!)
        : [],
      "Open in Reader": validUrl(document.url)
        ? Builder.url(validUrl(document.url)!)
        : [],
      Summary: summary.text ? Builder.richText(summary.text) : [],
      "Summary Truncated": Builder.checkbox(summary.truncated),
      Note: note.text ? Builder.richText(note.text) : [],
      "Note Truncated": Builder.checkbox(note.truncated),
      "Reading Progress":
        progress !== undefined && progress >= 0 && progress <= 1
          ? Builder.number(progress)
          : [],
      "Word Count":
        wordCount !== undefined && wordCount >= 0
          ? Builder.number(wordCount)
          : [],
      "Reading Time": trimmed(document.reading_time)
        ? Builder.richText(document.reading_time!.trim())
        : [],
      Published: dateValue(document.published_date),
      Saved: dateValue(document.saved_at),
      "Last Opened": dateValue(document.last_opened_at),
      Updated: dateValue(document.updated_at),
      "Reader Document ID": Builder.richText(document.id),
      "Source Key": Builder.richText(key),
    },
  }
}

export function exportSourceToChange(source: ReadwiseSource) {
  const key = exportSourceKey(source)
  // Reader LIST is authoritative for the unified reader:<id> row. Deleting a
  // Readwise highlight container must not temporarily erase a Reader document
  // that still exists; the two-source replacement sweep decides final absence.
  if (source.is_deleted) {
    return isReaderSource(source) ? undefined : { type: "delete" as const, key }
  }

  const summary = boundedText(source.summary)
  const note = boundedText(source.document_note)
  const category = normalizedCategory(source.category)
  const readerId = isReaderSource(source)
    ? trimmed(source.external_id)
    : undefined
  const title = source.readable_title ?? source.title
  const originalUrl = validUrl(source.source_url ?? source.unique_url)
  const reviewUrl = validUrl(source.readwise_url)

  return {
    type: "upsert" as const,
    key,
    properties: {
      Name: Builder.title(
        displayTitle(title, `Untitled Readwise source ${source.user_book_id}`)
      ),
      Origin: Builder.select(sourceName(source.source)),
      Category: category ? Builder.select(category) : [],
      Author: trimmed(source.author)
        ? Builder.richText(source.author!.trim())
        : [],
      Tags: Builder.multiSelect(...readwiseTagNames(source)),
      "Original URL": originalUrl ? Builder.url(originalUrl) : [],
      "Readwise Review": reviewUrl ? Builder.url(reviewUrl) : [],
      Summary: summary.text ? Builder.richText(summary.text) : [],
      "Summary Truncated": Builder.checkbox(summary.truncated),
      Note: note.text ? Builder.richText(note.text) : [],
      "Note Truncated": Builder.checkbox(note.truncated),
      ...(readerId ? { "Reader Document ID": Builder.richText(readerId) } : {}),
      "Readwise Source ID": Builder.richText(source.user_book_id),
      "Source Key": Builder.richText(key),
    },
  }
}
