---
name: document-retrieval
description: How the optional tools (listTrademarkDocuments + attachTrademarkDocumentToPage + refreshMarkImages) fetch US file-wrapper PDFs and mark images, and the hard-won gotchas — derived document IDs (bundle.xml carries no identifier), the 2025+ bundle-endpoint-first download ordering, %PDF and image magic-byte validation, TSDR's ~4/min PDF budget, icon decay on re-emits, and why the image sweep runs locally. Read before editing src/tools/documents.ts.
---

# Document retrieval

Three on-demand worker tools in `src/tools/documents.ts`, wired in `index.ts`
via `registerDocumentTools(worker)`:

- **`listTrademarkDocuments`** — a US case's file-wrapper documents from TSDR
  (office actions, responses, specimens, registration certificates), newest
  first.
- **`attachTrademarkDocumentToPage`** — fetches one as a PDF and attaches it
  under a Notion page (uploaded file → titled sub-page).
- **`refreshMarkImages`** — downloads + validates each row's mark image, then
  uploads it into the user-space "Mark Image" files property and the page
  icon.

They are tools, not syncs: they run only when invoked (no background load).
Remove the `registerDocumentTools(worker)` line in `index.ts` to drop the
feature. Tools **cannot use `worker.pacer`** (pacer handles exist only inside
the sync runtime), so politeness is structural: attach moves ONE document per
call, the image sweep processes a bounded batch. The TSDR helpers here are
deliberately duplicated from `src/sources/uspto.ts` so a tool tweak can never
destabilize the sync path (and vice versa).

Keys, both read at call time (`ntn workers env set` works on the next
invocation, no redeploy):

- **`TSDR_API_KEY`** — list + attach. The file-wrapper endpoints are keyed;
  this is the only part of the template that needs any key. Beware: an API-
  manager key issued for a different USPTO product can pass the gateway yet
  fail every TSDR call.
- **`NOTION_API_TOKEN`** — attach + refreshMarkImages (the multipart byte
  upload; the bundled SDK client can't do multipart). `list` needs neither
  Notion access nor the token.

## Derived document IDs (the non-obvious part)

TSDR's `casedocs/bundle.xml` listing carries **no identifier element at
all**. The single-document endpoint addresses a document as
`{DocumentTypeCode}{ScanDateTime → yyyyMMddHHmmss}`, so `parseDocsBundle`
derives the id from those two fields — that derived string is the
`documentIdentifier` the tools exchange. Consequence: **always `list` before
`attach`** to get exact identifiers; never construct one by hand.

US only: foreign rows are ST13-keyed and no connected source exposes their
file wrappers — `resolveSerial` refuses ST13 input outright rather than
querying TSDR with garbage digits. Registration numbers resolve rn → sn via
the TSDR status endpoint.

## Download ordering + validation (what cost real debugging time)

1. **TSDR's single-document ("casedoc") store stopped covering new documents**
   around the office's data-platform transition: documents from ~2025 onward
   404 there even though the bundle listing shows them, while older documents
   resolve fine. So attach orders its attempts by date: documents dated
   2025-01-01 or later skip casedoc entirely and go straight to the **bundle
   endpoint filtered by type + mail date** (`bundle.pdf?sn&type&date`); older
   documents try casedoc first with the bundle as backstop. Order matters
   because every attempt costs a PDF-class request. If two documents share
   type and date, the bundle PDF contains each of them — the response flags
   that instead of guessing.
2. **Never trust content-type.** TSDR serves plain-text/HTML error pages
   under assorted status codes. Only a buffer starting with `%PDF-` is
   uploaded; mark images are likewise magic-byte sniffed (PNG/JPEG/GIF/WEBP)
   because both image hosts serve HTML block pages too.
3. **TSDR's PDF budget is ~4/min per key**, with multi-minute penalties after
   repeated 429s. Attach therefore downloads ONE document per call — space
   calls **~90 s apart** and never run them in parallel. The tool does one
   bounded in-tool 429 retry (honoring `Retry-After`, capped at 45 s to fit
   the tool's execution budget), then returns `rate_limited` with
   `retryAfterSeconds`.
4. **20 MB single-part upload cap** on the Notion side; oversized files are
   refused with a clear error rather than attempted.

## Idempotent re-attach

The sub-page title (`<description> — <date>`) is built ONCE and reused for
both the existence check and the creation, so a retry after an ambiguous
failure can never duplicate. The children listing for that check is
**paginated** — portfolio pages accumulate document sub-pages, and a
first-100-only check quietly loses idempotency on busy pages. An existing
match returns `alreadyAttached` with the sub-page id.

## refreshMarkImages — and why icons decay

- **Sources:** an 8-digit serial fetches TSDR's keyless image endpoint
  (`tsdr.uspto.gov/img/...`); an ST13 fetches the TMview thumbnail (which
  renders the word element for word marks, so every foreign row has one).
  `DKT-` rows skip silently — no image source exists for them by design.
- **Why a tool and not the sync:** the sync write path can only reference
  external URLs in a files property — TSDR's endpoint has no file extension
  (Notion renders a generic chip), tmdn URLs are hotlink-blocked inside
  Notion, and both hosts serve HTML error pages when they block. So the tool
  downloads the bytes, PROVES they're an image, and uploads them with a real
  filename and MIME type.
- **"Mark Image" is deliberately user-space**, not in the managed schema:
  managed properties are read-only to users and tools, so a schema-declared
  files column could never be written by this tool — and being user-space is
  exactly why the sync never touches it and uploads survive re-emits. The
  tool creates the files property if it's missing.
- **Icon decay:** uploaded property values survive sync re-emits; page ICONS
  do not — an upsert with no icon field CLEARS the icon, so **every backfill
  wipes them**. Re-running this tool is the documented recovery; it always
  sets both surfaces, uploading the same bytes twice because a Notion file
  upload can be attached only once.
- **Batching:** `maxImages` rows per call (default 10, cap 25 — each row
  costs a download + two uploads + a page update inside the tool time
  limit); call repeatedly, passing `nextCursor` back as `startCursor`, until
  `hasMore` is false. `serialNumbers` narrows to specific rows. The database
  is resolved by title via search — single match or refuse-with-candidates,
  never a guess.
- **Run it LOCALLY.** TMview's thumbnail endpoint blocks datacenter egress
  even while its search answers, so a deployed run skips most foreign rows:
  `ntn workers exec refreshMarkImages --local -d '{"maxImages":25}'` from a
  residential network (it reads `.env`), looping on the cursor.
