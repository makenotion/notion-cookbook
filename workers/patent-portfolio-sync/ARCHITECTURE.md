# Architecture & customization

This is the technical reference for the patent-portfolio worker — useful once
you're up and running and want to extend or customize it. You don't need any of
this to onboard; see [`README.md`](README.md) for that. Your AI assistant can do
everything here for you; the relevant commands are `/connect-source`,
`/customize-schema`, and `/add-advanced-enrichment`. Deeper design notes (the
rules that keep the engine from breaking) live in [`AGENTS.md`](AGENTS.md) and
`.claude/skills/`.

New to the Notion Workers platform itself (sync modes, deploy, sync state,
credits)? This doc assumes that baseline — see Notion's
[Run custom code with Workers](https://www.notion.com/help/run-custom-code-with-workers)
and the [developer docs](https://developers.notion.com).

## Sources

| Source                              | Status                                               | Auth                    |
| ----------------------------------- | ---------------------------------------------------- | ----------------------- |
| **USPTO** Open Data Portal          | ✅ works out of the box (status, grant, publication) | free API key            |
| **EPO OPS** (European Register)     | ✅ works out of the box (status, grant, publication) | free OAuth key + secret |
| **Docketing** (your system)         | 🔧 example stub — you implement                      | your call               |
| **E-billing / spend** (your system) | 🔧 example stub — you implement                      | your call               |

USPTO and EPO are **independent** — enable at least one (both is fine) via
`config.sources` and supply only that office's keys. Run on US data alone,
Europe alone, or both; add the second anytime by flipping its toggle on and
providing its key. Both discover your applications by **applicant name** — no
docketing needed to get value on day one. US families are grouped automatically
from public continuity data. Connect docketing to group across offices
(US ↔ EP) and add docket numbers; connect a billing system to add cost.

## Architecture in one breath

`buildPortfolioRows()` (in `src/join.ts`) fetches each enabled source through a
`SourceRunner` (resilience), normalizes everything to a common `PatentRecord`,
groups records into families, enriches with docketing + spend, and emits rows.
A **backfill** sync (replace mode, manual, _strict_ — fails before emitting
partial data) is the consistency anchor; a **delta** sync (incremental, hourly,
_resilient_ — serves last-known-good on an outage) keeps Notion current and only
re-emits rows whose fingerprint changed. The delta only ever _upserts_;
deletions are left to the backfill, whose replace-mode mark-and-sweep removes
rows that have disappeared upstream (so re-run it periodically to prune). A
**health** sync probes each enabled source every 15 minutes and writes to a
**Sync Health** database — that table (not the sync status) is your outage
signal, because the delta degrades gracefully.

The reusable machinery in `src/engine/` (resilience, sync-state size
discipline, fetch timeouts, change detection) rarely needs editing and encodes
hard-won lessons — notably that sync state has a ~200KB _run-input_ limit below
the 256KB _save_ cap, so snapshots are gzipped and the adapters store
already-normalized `PatentRecord`s (not raw API payloads) to keep state small.
Change detection is fingerprint-based: bump `DERIVATION_VERSION`
(`engine/fingerprint.ts`) when you change how a field is _computed_ from
otherwise-unchanged inputs, or the delta won't know to re-emit it.

## Decisions you can make when setting up your own database

- **Which applicant name(s)** to track — `applicants` in `src/config.ts` (or
  `PORTFOLIO_APPLICANTS` in `.env`). List several if you file under more than
  one name.
- **Which sources** are on — `config.sources`. USPTO/EPO are on by default but
  independent: turn off the office you don't have keys for (at least one must
  stay on), and add it back later. Flip on `docketing`/`spend` once you've
  implemented those adapters (`src/sources/*.example.ts`) against your systems.
- **How families group** — automatically from US continuity out of the box;
  docketing adds cross-office grouping and your docket numbers — your docketing
  adapter derives the family id from the pattern you set in `config.docket`.
- **Which columns** the database has — the base is lean on purpose. Docket #
  appears only with docketing; spend columns only with a billing system. Richer
  fields (EP designated states, renewal payments, citations, INPADOC family
  IDs, US term/prosecution detail) are **opt-in** via `/add-advanced-enrichment`.
  Add or remove any column with `/customize-schema`.
- **A new patent office** (WIPO, JPO, a national register) — `/connect-source`
  walks through writing a new adapter.

## Optional: prosecution-document retrieval

Two on-demand **tools** (not syncs) in `src/tools/documents.ts`, wired in
`index.ts` and removable with one line:

- **`listProsecutionDocuments`** — lists a case's file-wrapper documents (US/WO
  or EP), newest-first.
- **`attachProsecutionDocumentToPage`** — fetches one as a **full multi-page
  PDF** and attaches it under a Notion page as a titled sub-page.

`list` uses the office API key you already have; `attach` additionally needs
`NOTION_API_TOKEN` (for the multipart byte upload). Bytes come from a different
place per office — US/WO from the USPTO file wrapper, EP published docs from
EPO OPS images, EP file-wrapper docs from the European Patent Register — and
each has non-obvious gotchas (Global Dossier is first-page-only; the EP
Register is rate-limited and page-capped; the ~60s tool limit forces concurrent
page fetch + merge). The **`document-retrieval` skill** documents all of it;
read it before editing the tools. Being on-demand, they add no background sync
load, so they ship registered by default.

## Sync cadence

- **`portfolioBackfill`** — manual. The consistency anchor and schema migrator;
  run it after any schema change (or the delta won't start). Triggers a full
  reload: `ntn workers sync trigger portfolioBackfill`.
- **`portfolioDelta`** — every **1 hour**. Keeps Notion current, serving
  last-known-good data through short upstream outages.
- **`healthSync`** — every **15 minutes**. Writes the **Sync Health** table.

## Quickstart (manual, if you'd rather not use `/setup`)

Requires Node ≥ 22 (LTS) and the `ntn` CLI
(`curl -fsSL https://ntn.dev | bash`).

```shell
npm install
cp .env.example .env          # fill in US and/or EPO keys (links inside)
# set your applicant name(s) in src/config.ts, and turn off any office
# you don't have keys for (config.sources.uspto / .epo — keep ≥ 1 on)
npm run check                 # type-check
ntn login                     # connect your Notion workspace
ntn workers deploy            # create the databases + capabilities
ntn workers env push --yes    # upload your keys to the worker
ntn workers sync trigger portfolioBackfill   # initial full load
```

Verify locally before deploying (prints the rows a run would produce, writes
nothing): `ntn workers exec portfolioBackfill --local`.

## Runbook: a source is down past the staleness cap

The delta serves last-known-good for 24h, then fails loud. To push fresh data
from the healthy sources during a prolonged outage of one:

```shell
ntn workers env set STALENESS_CAP_EXEMPT=epo   # or uspto
ntn workers sync trigger portfolioDelta
ntn workers env unset STALENESS_CAP_EXEMPT
```

## Layout

```
src/config.ts            # ← the main thing you customize
src/schema.ts            # Notion columns + row builders
src/join.ts              # the join / assembly
src/index.ts             # worker wiring (3 syncs + databases + optional tools)
src/engine/              # reusable: resilience, state, http (timeouts), fingerprint, pdf
src/sources/             # uspto, epo (live); docketing, spend (stubs)
src/tools/               # optional on-demand tools: document retrieval
README.md                # onboarding guide (no coding required)
ARCHITECTURE.md          # this file — technical reference & customization
AGENTS.md                # context for your AI assistant (CLAUDE.md symlinks here)
.claude/commands/        # /setup, /connect-source, /customize-schema, …
.claude/skills/          # engine, source-adapter, advanced-enrichment, document-retrieval
```
