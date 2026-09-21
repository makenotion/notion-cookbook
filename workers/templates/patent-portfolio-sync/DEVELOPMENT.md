# Adapt the patent portfolio template safely

You are helping someone adapt this Notion Worker to **their** patent portfolio.
The adopter is likely a legal-ops or IP professional, not necessarily a
TypeScript expert — explain what you're doing, and **ask before assuming**
(applicant names, which systems they use, which columns they want).

## Getting started with a new user

If they haven't set the project up yet, run the **`/setup`** slash command —
it's the guided onboarding wizard (keys, applicant, sources, optional advanced
enrichment, deploy). Other commands: `/connect-source`, `/customize-schema`,
`/add-advanced-enrichment`, `/deploy-checklist`.

## Where things live (and where to edit)

| Concern                                         | File                     | Edit frequency                                                     |
| ----------------------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| Applicant, which sources on, docket rule        | `src/config.ts`          | **start here**                                                     |
| Notion columns + row builders                   | `src/schema.ts`          | when adding/removing columns                                       |
| The join (fetch → normalize → enrich → emit)    | `src/join.ts`            | for new enrichment                                                 |
| Source adapters                                 | `src/sources/`           | per source                                                         |
| Optional document-retrieval tools               | `src/tools/documents.ts` | read `domain-guides/document-retrieval/SKILL.md` first             |
| Worker wiring (syncs, databases, pacers, tools) | `src/index.ts`           | rarely                                                             |
| Resilience / state / change detection           | `src/engine/`            | **almost never** — read `domain-guides/sync-engine/SKILL.md` first |

`ONBOARDING.md` is the no-code onboarding guide. `README.md` is the concise
developer-facing overview, and `ARCHITECTURE.md` is the deeper technical
reference (sources, sync model + hourly cadence, resilience, manual quickstart,
outage runbook). Keep detailed architecture out of the README.

USPTO + EPO ship live (discover by applicant name) and are independent — at
least one must be enabled in `config.sources`, but either runs alone (supply
only that office's keys; `buildPortfolioRows` throws if both are off, and
`healthSync` probes only the enabled offices). US parent continuity and EPO
divisional relations group same-office applications automatically
(`deriveContinuityFamilies` in `join.ts`); docketing extends grouping across
offices. `docketing.example.ts` and `spend.example.ts` are stubs the adopter
implements against their own systems.

## Rules that prevent breakage

1. **Adding a column travels in lockstep across three places:** the schema
   (`src/schema.ts` `buildSchema`), the row builder (`buildAppProperties` /
   `buildFamilyProperties`), and the fingerprint (the value must end up in the
   row's `fingerprintBasis` in `join.ts`, or the delta won't re-emit when it
   changes). Miss one and the column silently won't update.

2. **A derivation-rule change with unchanged inputs needs a re-emit trigger.**
   Bump `DERIVATION_VERSION` in `src/engine/fingerprint.ts` — it's folded into
   every fingerprint, forcing a one-time full re-emit. (E.g. you change how
   `Est. Expiry` is computed: the raw data didn't change, so without a bump the
   delta thinks nothing changed.)

3. **After any schema change, run the backfill before the delta.** A deploy
   that adds a column makes the delta crash on startup (empty logs) until the
   backfill's replace write applies the migration:
   `ntn workers sync trigger portfolioBackfill`, then the delta provisions.

4. **Sync state has two size limits.** Saves over 256KB are rejected; worse, a
   run _fails to start_ (instant exit, empty logs) when handed state above an
   undocumented ceiling that has tightened over time (~200KB in June 2026;
   ~99KB wedged production workers in August 2026). Snapshots are gzipped;
   project payloads at the fetch boundary to only fields the join reads, and
   pre-aggregate anything whose count grows without bound (invoices!). Every
   persisted backfill/delta state is measured as serialized UTF-8 and rejected
   at 78,000 bytes before changes are returned. Treat that guard as a hard,
   data-dependent portfolio boundary; never raise it toward the observed
   platform ceiling. See `domain-guides/sync-engine/SKILL.md`.

5. **Per-execute time budget is ~5 minutes.** Any enrichment that makes one
   API call per item (INPADOC, forward citations, per-matter spend) must be
   chunked/rotated across cycles, not done in one pass. See
   `domain-guides/sync-engine/SKILL.md`.

## Operational gotchas

- **`ntn login` for Notion auth** — the base template needs no `NOTION_API_TOKEN`.
- **Don't `source .env` in a shell before running `ntn`** — if `.env` exports a
  `NOTION_*` token it can shadow the CLI's own auth ("unauthorized"). Read
  individual vars instead.
- **Local verification writes nothing:** `ntn workers exec portfolioDelta --local`
  prints the rows a run would produce. Pass state with `-d '{"state":{...}}'`.
- **EPO OPS quirks:** OAuth tokens last ~20 min (cached). Portfolio discovery
  uses `/register/search/biblio`, whose pagination header is `Range` (not the
  published-data service's `X-OPS-Range`). Discovery must exhaust the reported
  total and then retrieve authoritative records by POST; the shared request and
  wall-clock budgets fail closed rather than returning a partial portfolio.
  Direct Register retrieval uses **epodoc** `EP` plus the eight-digit application
  number (for example `99203729` → `EP99203729`); the separate OPS family service
  uses docdb dot form. OPS throttles dynamically, so the 30/min pacer sits
  deliberately low.
- **Tools ≠ syncs (document-retrieval feature):** a tool's `execute` has a hard
  ~60s platform budget. The implementation deliberately enforces a 55-second
  operation deadline, leaving headroom for cleanup and response serialization.
  Tools **cannot use `worker.pacer`** (`.wait()` throws "Pacer not found"
  outside the sync runtime), so they self-throttle with bounded concurrency +
  backoff and page-cap slow sources. `attach` needs `NOTION_API_TOKEN`
  (multipart upload); `list` does not. See
  `domain-guides/document-retrieval/SKILL.md`.

## Conventions

- Two spaces for indentation. `module: nodenext` → **relative imports need `.js`**
  extensions (`import { x } from "./engine/state.js"`).
- Row keys are jurisdiction-prefixed (`US-…`, `EP-…`) to avoid collisions.
- `Est. Expiry` only populates once granted (a pending case may never grant).
  It is a baseline portfolio estimate, not a docketing deadline: PTA, PTE,
  terminal disclaimers, reissue adjustments, SPCs, and national extensions
  require authoritative legal data that the base adapters do not fetch. It also
  stays blank when a term-bearing continuity filing date is missing rather than
  falling back to a later child filing date.
- The backfill is **strict** (any source failure throws before emitting); the
  delta is **resilient** (serves last-known-good on outage). Never make the
  backfill resilient — it would mark-and-sweep live rows on partial data.

## Patent domain guides

- **[`sync-engine`](domain-guides/sync-engine/SKILL.md)** — resilience,
  state-size discipline, change detection, resolution budgeting. Read before
  touching `src/engine/` or adding per-item enrichment.
- **[`source-adapter`](domain-guides/source-adapter/SKILL.md)** — the
  `PatentRecord` contract and how to write a new source. Read before adding a
  source.
- **[`advanced-enrichment`](domain-guides/advanced-enrichment/SKILL.md)** —
  recipes (with real API specifics) for INPADOC
  family IDs, forward citations, US prosecution/term metadata, the EP orphan
  audit, and EP register detail (designated states, EPO application renewals,
  X/Y citations). It also records the boundary that legal status and deadlines
  must come from authoritative per-office or docketing sources. Drives
  `/add-advanced-enrichment`.
- **[`document-retrieval`](domain-guides/document-retrieval/SKILL.md)** — how
  the optional `listProsecutionDocuments` /
  `attachProsecutionDocumentToPage` tools fetch full file-wrapper PDFs across
  US/WO/EP, and the gotchas (Global Dossier is first-page-only; EP bytes come
  from the rate-limited EP Register; the internal 55-second deadline leaves
  headroom under the ~60s platform limit; tools can't use the sync pacer). Read
  before editing `src/tools/`. It also records the whole-source atomic-failure
  rule that docketing suppression relies on.
