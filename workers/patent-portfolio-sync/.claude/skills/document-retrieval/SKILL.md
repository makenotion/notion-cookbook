---
name: document-retrieval
description: How the optional prosecution-document tools (listProsecutionDocuments + attachProsecutionDocumentToPage) fetch full file-wrapper PDFs across US/WO/EP, and the hard-won gotchas — Global Dossier is first-page-only, EP file-wrapper bytes come from the EP Register, EP published docs from EPO OPS images, the ~60s tool limit, and why a worker's fetch can't pace or send Expect. Read before editing src/tools/documents.ts.
---

# Document retrieval

Two on-demand worker tools in `src/tools/documents.ts`, wired in `index.ts` via
`registerDocumentTools(worker)`:

- **`listProsecutionDocuments`** — lists a case's file-wrapper documents.
- **`attachProsecutionDocumentToPage`** — fetches one as a full PDF and attaches
  it under a Notion page (uploaded file → titled sub-page).

They are tools, not syncs: they run only when invoked (no background load).
`list` needs the office API key; `attach` additionally needs `NOTION_API_TOKEN`
(the multipart byte upload — the bundled SDK can't do multipart). Remove the
`registerDocumentTools(worker)` line in `index.ts` to drop the feature.

## Where the bytes actually come from (the non-obvious part)

There is no single API that returns a full multi-page file-wrapper PDF. Each
office is different, and the obvious source is usually wrong:

| Document                                                              | Source                                                        | Why                                                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **US + PCT/WO** file wrapper                                          | USPTO ODP `/applications/{n}/documents`                       | Full PDF in one request. PCT docs (ISR, written opinion, pamphlet) live in the US wrapper because filing is at RO/US. |
| **EP published application** (pamphlet)                               | EPO OPS **images**                                            | Our credentialed API; full doc, fetched per-page (`Range: N`) and merged. Fast.                                       |
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
   a clear message rather than timing out. Large EP priority documents are also
   in the US/WO wrapper (call with `jurisdiction: "WO"`).

3. **There is a hard ~60s tool-execution limit.** A worker tool is not a sync —
   no multi-cycle budget. Fetching pages sequentially blows it on large docs, so
   `fetchAndMergePdfPages` (`engine/pdf.ts`) fetches concurrently and merges in
   order. Cap page counts on any throttled/slow source.

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

6. **OPS images serves one page per `Range` request** (a numeric `Range: N`
   header, not a byte range; multi-page ranges are ignored). Resolve
   application → publication (use the **docdb** document-id, which carries the
   A1/B1 kind; the epodoc form is a bare number with no kind) → the
   `FullDocument` image instance → loop pages → merge.

## Extending / changing it

- **Confirm the Global Dossier host.** `GD_API_BASE` in `documents.ts` is a
  placeholder — GD's public API host has changed before; verify the current one
  (watch the network tab on globaldossier.uspto.gov) before relying on EP listing.
- **Reachability probe.** GD and the EP Register can be blocked or throttled
  from the worker's egress IP even when the service is up. If EP retrieval
  silently fails in production, add a `healthSync` probe (in `index.ts`'s
  `HEALTH_ENDPOINTS`) that fetches a known EP application's Register doclist —
  fill in an application number you own.
- **JP/CN/KR.** Global Dossier lists their docs too, but there is no Register
  equivalent and GD is first-page-only, so they're intentionally not wired.

## Heads-up for the resilience / docketing path (related lesson)

These tools are read-only, but the same upstream-flakiness shaped a sync lesson
worth recording here (see also the `sync-engine` skill):

- **Per-app last-known-good gap.** `sources/epo.ts` catches _per-application_
  register failures and skips that app (`SourceRunner` only does _whole-source_
  fallback). A transient per-app error (EPO OPS has been seen to return **500
  `SERVER.DomainAccess`** on individual apps) therefore drops that row for the
  cycle. In the base template that's a benign stale row until the next backfill.
  But **if you add docketing suppression** (promoting a public office row over a
  docket "shadow" row), a dropped public row un-suppresses its shadow while the
  incremental delta never sweeps the now-stale public row — producing a
  **duplicate**. Two fixes, both worth applying when you build suppression:
  (a) carry forward the prior cycle's record on a per-app failure (serve
  last-known-good per app, not just per source); and (b) when a public row is
  absent this cycle but was emitted before, _hold_ it (suppress the shadow)
  rather than flip to the shadow — detectable from the prior fingerprint keys.
