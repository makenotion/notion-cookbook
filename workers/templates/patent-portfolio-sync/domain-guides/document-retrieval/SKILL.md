---
name: document-retrieval
description: How the optional prosecution-document tools (listProsecutionDocuments + attachProsecutionDocumentToPage) fetch full file-wrapper PDFs across US/WO/EP, and the hard-won gotchas — Global Dossier is first-page-only, EP file-wrapper bytes come from the EP Register, EP published docs from EPO OPS images, the internal 55-second deadline that leaves headroom under the ~60s platform limit, and why a worker's fetch can't pace or send Expect. Read before editing src/tools/documents.ts.
---

# Document retrieval

Two on-demand worker tools in `src/tools/documents.ts`, wired in `index.ts` via
`registerDocumentTools(worker)`:

- **`listProsecutionDocuments`** — lists a case's file-wrapper documents.
- **`attachProsecutionDocumentToPage`** — fetches one as a full PDF and attaches
  it under a Notion page (uploaded file → titled sub-page).

They are tools, not syncs: they run only when invoked (no background load).
US/WO listing needs `USPTO_API_KEY`. Direct EP listing needs no USPTO key;
`EPO_CONSUMER_KEY/SECRET` optionally route the published A1/A2 application
through OPS images. `attach` uses `NOTION_API_TOKEN`; Custom Agent calls inject
it automatically, while local execution must set a connection token with
access to the target page. Remove the
`registerDocumentTools(worker)` line in `index.ts` to drop the feature.

## Where the bytes actually come from (the non-obvious part)

There is no single API that returns a full multi-page file-wrapper PDF. Each
office is different, and the obvious source is usually wrong:

| Document                                                              | Source                                                        | Why                                                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **US + PCT/WO** file wrapper                                          | USPTO ODP `/applications/{n}/documents`                       | Full PDF in one request. PCT docs (ISR, written opinion, pamphlet) live in the US wrapper because filing is at RO/US. |
| **EP published application** (pamphlet)                               | EPO OPS **images**                                            | Our credentialed API; full doc, fetched per-page (`X-OPS-Range: N`) and merged. Fast.                                 |
| **EP file-wrapper** (office actions, search report, claims, priority) | **EP Register file-inspection** (`application?showPdfPage=N`) | The only full source. One page per request; **rate-limited**.                                                         |

### Gotchas that cost real debugging time

1. **Global Dossier's public content endpoint is first-page-only.** GD's
   `doc-list` is great for _listing_ EP docs (it gives the doc id + page count,
   and the doc id is the SAME one the EP Register uses), but its
   `doc-content/.../{page}/PDF` returns page 1 for _every_ page index — the
   real GD web app fetches full docs from an internal authenticated backend
   (`apiURL="internal"` in its bundle) you can't reach. So: **list from GD,
   fetch EP bytes from the EP Register.** Don't try to loop GD pages — they're
   all page 1.

2. **The EP Register is heavily rate-limited** (~1.5–1.8s/page at 4-wide; long
   runs trip a throttle that returns HTML-with-a-200, not a PDF). So:
   concurrency is low, we re-check `content-type` on every page, and the page
   count is **capped (`EP_REGISTER_MAX_PAGES`)** — larger docs are refused with
   a clear message rather than timing out. OPS image retrieval has its own
   `OPS_MAX_DOC_PAGES` cap; it also refuses oversized documents instead of
   silently returning the first N pages. Large EP priority documents are also
   in the US/WO wrapper (call with `jurisdiction: "WO"`).

3. **There is a hard ~60s tool-execution limit.** A worker tool is not a sync —
   no multi-cycle budget. The implementation deliberately uses a 55-second
   operation deadline, reserving the remaining headroom for cleanup, response
   serialization, and runtime scheduling overhead. Fetching pages sequentially
   still blows the budget on large docs, so `fetchAndMergePdfPages`
   (`engine/pdf.ts`) fetches concurrently and merges in order. Cap page counts
   on any throttled/slow source.

4. **A worker's `fetch` (undici) cannot pace via `worker.pacer`, and cannot send
   an `Expect` header.** Pacers exist only in the sync runtime — calling
   `.wait()` in a tool throws _"Pacer not found"_; tools self-throttle with
   bounded concurrency + backoff instead. And undici throws on an `Expect`
   request header, which also means the worker never sends `Expect: 100-continue`
   — so don't reach for that to fix a 417 (see next).

5. **Don't add a "CORS" OPTIONS preflight to a server-side download.** An OPTIONS
   preflight that looked necessary from a browser context was found to _poison_
   the subsequent binary GET from the worker's network (HTTP **417**). Plain GET
   with browser-like headers (`Origin`/`Referer`/`User-Agent`) is what works.

6. **OPS images serves one page per `X-OPS-Range` request** (a numeric
   `X-OPS-Range: N` header; multi-page ranges are not supported). The image
   instance's `link` is relative to `/published-data/images/`. Resolve the exact
   EP application → its matching **A1/A2** docdb publication → the identity-
   checked `FullDocument` image instance → loop pages → validate and merge.
   Never recursively scan an OPS envelope: it may contain cited or related
   publications, and a bare B-kind result is the granted patent, not the
   published application pamphlet.

7. **Identifiers are intentionally unambiguous.** Supply exactly one of
   `applicationNumber` or `patentNumber`. A direct EP application must be
   EP-prefixed (for example `EP03789660.2`); a bare 8-digit number used with
   `jurisdiction: "EP"` is treated as a US family anchor. If that family has
   multiple EP members, the tool returns the candidates instead of picking the
   first one. Explicit office prefixes must agree with `jurisdiction`.

8. **Upstream bytes and envelopes fail closed.** Global Dossier and USPTO JSON
   shapes, dates, and page counts are validated. PDF downloads require a PDF
   content type, signature, parseable structure, and the expected per-page page
   count. OPS retries one revoked-token 401 with single-flight token refresh and
   retries transient 408/429/5xx or HTML-with-200 responses.

## Extending / changing it

- **Re-confirm the Global Dossier host when it fails.** `GD_API_BASE` is the
  opaque CloudFront host currently used by the public GD web app, not a stable
  documented API hostname. It has changed before; verify the current request
  host in the network tab on globaldossier.uspto.gov before changing code.
- **Reachability probe.** GD and the EP Register can be blocked or throttled
  from the worker's egress IP even when the service is up. If EP retrieval
  silently fails in production, add a `healthSync` probe (in `index.ts`'s
  `HEALTH_ENDPOINTS`) that fetches a known EP application's Register doclist —
  fill in an application number you own.
- **JP/CN/KR.** Global Dossier lists their docs too, but there is no Register
  equivalent and GD is first-page-only, so they're intentionally not wired.

## Sync resilience boundary (related lesson)

These tools are read-only, but office adapters must remain **whole-source
atomic** (see `domain-guides/sync-engine/SKILL.md` and
`domain-guides/source-adapter/SKILL.md`). If discovery or any required
per-application retrieval or validation fails, the adapter throws instead of
returning a partial array. A strict backfill then aborts before writes; a
resilient delta serves the prior complete source snapshot.

Preserve that rule when adding docketing suppression. A silently skipped public
record can un-suppress a docket shadow while leaving the old public row in the
incremental database, creating a duplicate. Do not add per-app `catch`/`continue`
logic unless the state model first gains an explicit, tested per-record
last-known-good contract.
