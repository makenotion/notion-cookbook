# Architecture & customization

This is the technical reference for the trademark-portfolio worker — useful
once you're up and running and want to extend or customize it. You don't need
any of this to onboard; see [`ONBOARDING.md`](ONBOARDING.md) for that, and
[`README.md`](README.md) for the developer overview. Your AI assistant can do
everything here for you: [`AGENTS.md`](AGENTS.md) contains the canonical
Worker guidance, while [`DEVELOPMENT.md`](DEVELOPMENT.md) and
[`domain-guides/`](domain-guides/) document this recipe's engine and
integrations. `AGENTS.md`, `CLAUDE.md`, and `.claude/skills` point to the
cookbook's generated canonical Worker guidance. Claude Code users can run
`/setup`; other assistants can follow `.claude/commands/setup.md`.

New to the Notion Workers platform itself (sync modes, deploy, sync state,
credits)? This doc assumes that baseline — see the
[Notion Workers documentation](https://developers.notion.com/workers/get-started/overview).

## Sources

| Source                                            | Status                          | Auth                        | Pacer           |
| ------------------------------------------------- | ------------------------------- | --------------------------- | --------------- |
| **USPTO search**                                  | ✅ works out of the box         | **none — keyless**          | 10/min          |
| **TMview** (all non-US offices)                   | ✅ works out of the box         | **none — keyless**          | 6/min           |
| **TSDR overlay** (same-day US data + Status Date) | 🔑 optional upgrade             | free API key                | 60/min          |
| **Counsel Docket Inbox**                          | 🔧 live, config-gated           | Notion integration token    | — (Notion API)  |
| **IP Australia** (official overlay)               | 🔑 optional upgrade             | free OAuth, registration    | 60/min (shared) |
| **EUIPO** (official overlay)                      | 🔑 optional upgrade             | free OAuth, manual approval | 60/min (shared) |
| **E-billing / spend** (your system)               | 🔧 example stub — you implement | your call                   | —               |

**Keyless-first is the design center.** The two row-defining registry sources
need no credentials, so the template deploys before any key paperwork clears;
every credential is an optional, _independent_ upgrade, read at **run time**
— `ntn workers env set TSDR_API_KEY=…` upgrades the next cycle, no redeploy,
and each key-gated health probe appears only once its key is configured.
One keyless capability was lost upstream: USPTO retired TSDR's keyless
last-update endpoint (2026-07-30), so **Status Date on US rows — and the
OA-response deadlines anchored on it — now require the TSDR key**; keyless
deployments still get everything tmsearch carries. The
trade-off of keyless: both backends are undocumented and WAF-fronted, so
their pacer budgets (declared in `src/index.ts`) are deliberately tiny —
nothing this worker does should ever look like scraping — and the platform
caps a worker at 5 pacers, shared across syncs and probes (tools get none).
TMview is a **mirror**, not the register of record; the official overlays fix
exactly that for AU and EU rows, as enrichment that can never fail a cycle.

## Architecture in one breath

`buildPortfolioRows()` (in `src/join.ts`) fetches each enabled source through
a `SourceRunner` (resilience) in trust order: **counsel docket first** (its
deadline overrides, lapse flags, and counsel-only rows feed every other row
builder), then **USPTO** (US rows), **TMview** (all other rows), **official
overlays** and **spend** (enrichment, never cycle-fatal). Deadline precedence
is counsel's docketed date > computed statutory estimate > office expiration
date > none — and the estimates deliberately don't model extensions or grace
periods, so an overdue date is a look-into-it signal, not proof of lapse. A
**backfill** sync (replace mode, manual, _strict_ — any row-defining failure
aborts before emitting) is the consistency anchor and schema migrator; a
**delta** sync (incremental, hourly, _resilient_ — serves last-known-good on
an outage) re-emits only rows whose fingerprint changed, and only ever
_upserts_ — deletions are left to the backfill's replace-mode mark-and-sweep
(re-run it periodically to prune). A **health** sync probes each enabled
source every 15 minutes and writes a **Sync Health** database — that table
(not the sync status) is your outage signal, because the delta degrades
gracefully. One probe is deliberately expensive: the Counsel Docket Inbox row
dry-runs the full parse, because a bad report is otherwise absorbed
_silently_ (the previous good parse keeps serving, by design).

Both write syncs separate acquisition from emission. They fetch and validate a
complete source set once, gzip it, and carry only that frozen snapshot plus
compressed pending keys through later 100-row pages. Page 2 and beyond perform
no registry requests, so upstream inserts, deletes, reordering, or a new outage
cannot move a page boundary within a cycle. Versioned state is validated before
use; a derivation or source-toggle change during an in-progress frozen cycle
fails with an instruction to restart that cycle.

The reusable machinery in `src/engine/` (resilience, sync-state size
discipline, fetch timeouts, change detection, the zero-dependency xlsx
reader) rarely needs editing and encodes hard-won lessons — notably that sync
state hits an undocumented _run-input_ ceiling well below the 256KB _save_
cap (observed ~200KB in June 2026, ~99KB in August 2026 — treat it as
moving), so snapshots are gzipped, the adapters store already-normalized
records rather than raw API payloads, and per-transaction data whose count
grows without bound is pre-aggregated at the fetch boundary. Every persisted
backfill/delta state is measured as serialized UTF-8 and rejected at 78,000
bytes before any changes are returned; reduce the projection rather than
raising that guard. Change detection is fingerprint-based: bump `DERIVATION_VERSION`
(`engine/fingerprint.ts`) when you change how a field is _computed_ from
otherwise-unchanged inputs — including the docket parsers — or the delta
won't know to re-emit it.

## Decisions you can make when setting up your own database

- **Which owner name(s)** to track — `ownerNames` in `src/config.ts` (or
  `PORTFOLIO_OWNERS` in `.env`). List several if your marks are held by more
  than one entity; the same strings validate counsel's Properties Report.
- **Which sources** are on — `config.sources`. USPTO and TMview ship on
  (keyless); `counselDocket` needs `DOCKET_INBOX_PAGE_ID` +
  `NOTION_API_TOKEN` and, ideally, `config.docketClientNumber` (the
  wrong-client guard); `ipAustralia` / `euipo` need approved credentials;
  `spend` needs your adapter.
- **Your firm's report format** — the `CUSTOMIZE`-marked column names,
  filename patterns, and reference scheme in `src/sources/counsel-docket.ts`
  match one real docketing-system export; adjust them to your firm's.
- **How deadlines compute** — the deadline engine in `src/join.ts` is plain,
  tested code; adjust it if your docketing practice differs. Counsel's dates
  override it either way.
- **Which columns** the database has — `src/schema.ts`. Conditional columns
  appear with their feature (Lapse Instructed with the docket; spend columns
  with a billing system), and select vocabularies are pre-declared generously
  (offices, all 45 Nice classes) because adding an option later is a schema
  migration.
- **Another office or register** — a new adapter in `src/sources/` against
  the contracts in `src/sources/types.ts`; see the
  [`source-adapter` domain guide](domain-guides/source-adapter/SKILL.md).

## Optional: documents and mark images

Three on-demand **tools** (not syncs) in `src/tools/documents.ts`, wired in
`index.ts` (`registerDocumentTools(worker)`) and removable with one line:

- **`listTrademarkDocuments`** — a US case's file-wrapper documents from TSDR
  (office actions, responses, specimens, registration certificates).
- **`attachTrademarkDocumentToPage`** — fetches one as a PDF and attaches it
  under a Notion page.
- **`refreshMarkImages`** — downloads and validates each row's mark image,
  then uploads it as a **Mark Image** files property and the page icon.

`list` and `attach` need the optional `TSDR_API_KEY` (the file-wrapper
endpoints are keyed); `attach` and `refreshMarkImages` additionally need
`NOTION_API_TOKEN` (the multipart byte upload — for `refreshMarkImages`, with
access to the portfolio database). Tools can't use the worker's pacers (those
exist only inside the sync runtime), so politeness is structural: `attach`
moves **one document per call** against TSDR's separate ~4/min PDF budget.
Run `refreshMarkImages` locally (`ntn workers exec refreshMarkImages
--local`) — TMview's thumbnail endpoint often blocks datacenter egress — and
re-run it after a backfill, because replace-mode re-emits clear tool-set
icons. On-demand means no background sync load, so the tools ship registered
by default; the
[`document-retrieval` domain guide](domain-guides/document-retrieval/SKILL.md)
documents the details.

## Sync cadence

- **`portfolioBackfill`** — manual. The consistency anchor and schema
  migrator; run it after any schema change (or the delta won't start):
  `ntn workers sync trigger portfolioBackfill`.
- **`portfolioDelta`** — every **1 hour**. Keeps Notion current, serving
  last-known-good data through upstream outages.
- **`healthSync`** — every **15 minutes**. Writes the **Sync Health** table,
  including the full counsel-docket dry-run.

## Quickstart (manual, if you'd rather not use `/setup`)

Requires Node ≥ 22 (LTS) and the `ntn` CLI
(`curl -fsSL https://ntn.dev | bash`). No API keys.

```shell
npm install
# set your owner name(s) in src/config.ts — the only required customization
npm run check                 # type-check
ntn login                     # connect your Notion workspace
ntn workers deploy --name trademark-portfolio-sync
ntn workers sync trigger portfolioBackfill   # initial full load
```

Optional upgrades go in `.env` (`cp .env.example .env`, links inside) and
upload with `ntn workers env push --yes` — each is read at run time. Verify
locally before deploying (prints the rows a run would produce, writes
nothing): `ntn workers exec portfolioBackfill --local`.

## Runbook: a source is down past the staleness cap

Per-source caps match how the data decays: the WAF-fronted keyless backends
(`uspto`, `tmview`) serve last-known-good for **7 days** — blocks can outlast
a day while the data barely moves — keyed overlays get the 24h default, and
counsel reports have **no cap**: a docket report stays the truth until the
next one arrives. Past its cap, the delta fails loud. To push fresh data
during a prolonged outage of one source:

```shell
ntn workers env set STALENESS_CAP_EXEMPT=tmview   # or uspto
ntn workers sync trigger portfolioDelta
ntn workers env unset STALENESS_CAP_EXEMPT
```

## Layout

```text
src/config.ts            # ← the main thing you customize
src/schema.ts            # Notion columns (generous select vocabularies)
src/join.ts              # the join / assembly, row builders, deadline engine
src/index.ts             # worker wiring (3 syncs + databases + pacers + tools)
src/engine/              # reusable: resilience, state, http (timeouts), fingerprint, xlsx
src/sources/             # uspto, tmview, counsel-docket, ipaustralia, euipo (live); spend (stub)
src/tools/               # optional on-demand tools: documents + mark images
README.md                # developer overview
ONBOARDING.md            # no-code setup guide for legal / legal-ops users
ARCHITECTURE.md          # this file — technical reference & customization
.agents/                 # generated canonical instructions and Worker skills
AGENTS.md                # symlink to .agents/INSTRUCTIONS.md
CLAUDE.md                # symlink to .agents/INSTRUCTIONS.md
DEVELOPMENT.md           # recipe-specific engineering guide
.claude/                 # guided setup commands and recipe-specific skills
```
