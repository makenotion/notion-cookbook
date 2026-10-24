// One Sources database unifies top-level Reader documents with Readwise Books
// metadata and Highlight Export containers. Reader-backed export sources use
// the Reader document id, so highlights can relate to the richer Reader row
// without relying on titles or URLs as identity.

import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

import type {
  ReaderDocument,
  ReadwiseBook,
  ReadwiseSource,
} from "./readwise.js"
import {
  boundedText,
  dateValue,
  displayLabel,
  displayTitle,
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
    ]),
    "Reading Progress": Schema.number("percent"),
    Saved: Schema.date(),
    Author: Schema.richText(),
    Category: Schema.select([]),
    Tags: Schema.multiSelect([]),
    "Last Opened": Schema.date(),
    "Open in Readwise": Schema.url(),
    Summary: Schema.richText(),
    Note: Schema.richText(),
    Site: Schema.richText(),
    Origin: Schema.select([]),
    "Reading Time": Schema.richText(),
    Published: Schema.date(),
    "Original URL": Schema.url(),
    "Removed upstream": Schema.checkbox(),
    "Source Key": Schema.richText(),
  },
} satisfies Schema.Schema<typeof SOURCES_PRIMARY_KEY>

type SourceChange = SyncChangeUpsert<
  typeof SOURCES_PRIMARY_KEY,
  typeof sourceSchema.properties
>

// Sync upserts apply only the supplied properties; omitted properties keep
// their existing values. The 0.4 SDK type models a complete schema, so keep
// this temporary type narrowing isolated to intentional property patches.
function sourcePropertyPatch(
  properties: Partial<SourceChange["properties"]>
): SourceChange["properties"] {
  return properties as SourceChange["properties"]
}

export function readerSourceKey(documentId: string): string {
  const id = documentId.trim()
  if (!id) throw new Error("Reader document id cannot be empty.")
  return `reader:${id}`
}

function isReaderOrigin(source: string): boolean {
  return source.trim().toLowerCase() === "reader"
}

function isReaderSource(source: ReadwiseSource): boolean {
  return isReaderOrigin(source.source)
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

const READER_LOCATION_LABELS: Record<string, string> = {
  new: "Inbox",
  later: "Later",
  shortlist: "Shortlist",
  archive: "Archive",
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
  document: ReaderDocument
): SourceChange | undefined {
  // Reader also models its highlights and notes as documents. parent_id is the
  // documented discriminator; those records come from Readwise Export instead.
  if (document.parent_id !== null) return undefined

  const rawLocation = trimmed(document.location)?.toLowerCase()
  // Feed items are a high-volume inbox, not a deliberate reading queue. They
  // still appear when Readwise Export contains highlights for them.
  if (rawLocation === "feed") return undefined

  const key = readerSourceKey(document.id)
  const summary = boundedText(document.summary)
  const note = boundedText(document.notes)
  const category = categoryLabel(normalizedCategory(document.category))
  const location = readerLocationLabel(rawLocation)
  const updatedAt = validDate(document.updated_at)
  const readerUrl = validUrl(document.url)
  const originalUrl = validUrl(document.source_url)

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
        document.reading_progress !== null
          ? Builder.number(document.reading_progress)
          : [],
      Category: category ? Builder.select(category) : [],
      Author: trimmed(document.author)
        ? Builder.richText(document.author!.trim())
        : [],
      Site: trimmed(document.site_name)
        ? Builder.richText(document.site_name!.trim())
        : [],
      Tags: Builder.multiSelect(...readerTagNames(document.tags)),
      Summary: summary ? Builder.richText(summary) : [],
      Note: note ? Builder.richText(note) : [],
      Origin: Builder.select("Reader"),
      "Reading Time": trimmed(document.reading_time)
        ? Builder.richText(document.reading_time!.trim())
        : [],
      Saved: dateValue(document.saved_at),
      "Last Opened": dateValue(document.last_opened_at),
      Published: dateValue(document.published_date),
      "Open in Readwise": readerUrl ? Builder.url(readerUrl) : [],
      "Original URL": originalUrl ? Builder.url(originalUrl) : [],
      "Removed upstream": Builder.checkbox(false),
      "Source Key": Builder.richText(key),
    },
  }
}

function retainedSourcePatch(key: string, removed: boolean) {
  return {
    "Removed upstream": Builder.checkbox(removed),
    "Source Key": Builder.richText(key),
  }
}

function readerExportPatch(source: ReadwiseSource, key: string) {
  const title = trimmed(source.readable_title) ?? trimmed(source.title)
  return {
    // Source is intentionally shared: Export must be able to name a highlighted
    // Feed item that Reader import excludes. Queue fields remain Reader-owned.
    Source: Builder.title(
      displayTitle(title, `Untitled Readwise source ${source.user_book_id}`)
    ),
    ...retainedSourcePatch(key, false),
  }
}

function nonReaderExportPatch(source: ReadwiseSource, key: string) {
  const summary = boundedText(source.summary)
  const title = trimmed(source.readable_title) ?? trimmed(source.title)

  return {
    // Source is intentionally shared: Export can observe a new highlight after
    // this cycle's Books cutoff and must create a named relation target.
    Source: Builder.title(
      displayTitle(title, `Untitled Readwise source ${source.user_book_id}`)
    ),
    Summary: summary ? Builder.richText(summary) : [],
    ...retainedSourcePatch(key, false),
  }
}

export function readwiseBookToChange(
  book: ReadwiseBook
): SourceChange | undefined {
  // Reader LIST has the stable document id needed for unified reader:<id>
  // rows. Books LIST does not expose that id, so it only owns non-Reader
  // source metadata.
  const category = normalizedCategory(book.category)
  if (isReaderOrigin(book.source) || book.num_highlights === 0) {
    return undefined
  }

  const key = `readwise:${book.id}`
  const categoryName = categoryLabel(category)
  const note = boundedText(book.document_note)
  const readwiseUrl = validUrl(book.highlights_url)
  const originalUrl = validUrl(book.source_url)

  return {
    type: "upsert" as const,
    key,
    upstreamUpdatedAt: book.updated,
    properties: sourcePropertyPatch({
      Source: Builder.title(
        displayTitle(book.title, `Untitled Readwise source ${book.id}`)
      ),
      Author: trimmed(book.author) ? Builder.richText(book.author!.trim()) : [],
      Category: categoryName ? Builder.select(categoryName) : [],
      Tags: Builder.multiSelect(
        ...uniqueSelectNames(book.tags.map((tag) => tag.name))
      ),
      Note: note ? Builder.richText(note) : [],
      Origin: Builder.select(sourceName(book.source)),
      "Open in Readwise": readwiseUrl ? Builder.url(readwiseUrl) : [],
      "Original URL": originalUrl ? Builder.url(originalUrl) : [],
      "Source Key": Builder.richText(key),
    }),
  }
}

export function exportSourceToChange(
  source: ReadwiseSource
): SourceChange | undefined {
  const key = exportSourceKey(source)
  const readerId = readerExternalId(source)
  if (source.is_deleted) {
    // Removing the Export representation does not remove the unified Reader
    // document. Reader LIST has no matching deletion tombstone, so preserve
    // that Source as active rather than inferring its state from one API.
    if (readerId) return undefined

    const title = trimmed(source.readable_title) ?? trimmed(source.title)
    // A partial upsert marks the retained row without clearing its last useful
    // metadata or the user's Notion context.
    return {
      type: "upsert" as const,
      key,
      properties: sourcePropertyPatch({
        ...(title
          ? {
              Source: Builder.title(
                displayTitle(
                  title,
                  `Removed Readwise source ${source.user_book_id}`
                )
              ),
            }
          : {}),
        ...retainedSourcePatch(key, true),
      }),
    }
  }

  // Reader owns its queue metadata. Export updates only the intentionally
  // shared title plus archive bookkeeping.
  if (readerId) {
    return {
      type: "upsert" as const,
      key,
      properties: sourcePropertyPatch(readerExportPatch(source, key)),
    }
  }

  return {
    type: "upsert" as const,
    key,
    properties: sourcePropertyPatch(nonReaderExportPatch(source, key)),
  }
}
