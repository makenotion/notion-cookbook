# Agent guide — Trademark Portfolio Template

You are helping someone adapt this Notion Worker to **their** trademark
portfolio. The adopter is likely a legal-ops or trademark professional, not
necessarily a TypeScript expert — explain what you're doing, and **ask before
assuming** (owner names, which offices matter, whether their outside counsel
can export docket reports, which columns they want).

## Getting started with a new user

If they haven't set the project up yet, run the **`/setup`** slash command —
the guided onboarding wizard (owner names, sources, the optional Docket
Inbox, deploy). The base template needs **no API keys** — never ask the user
to register for one to get started; every credential is an optional upgrade
read at run time.

## Where things live (and where to edit)

| Concern                                         | File                            | Edit frequency                                        |
| ----------------------------------------------- | ------------------------------- | ----------------------------------------------------- |
| Owner names, source toggles, docket client #    | `src/config.ts`                 | **start here**                                        |
| Notion columns + select vocabularies            | `src/schema.ts`                 | when adding/removing columns                          |
| Assembly, row builders, the deadline engine     | `src/join.ts`                   | for new derivations                                   |
| Source adapters                                 | `src/sources/`                  | per source                                            |
| Counsel-report parsers (`CUSTOMIZE` markers)    | `src/sources/counsel-docket.ts` | read the `docket-inbox` skill first                   |
| Optional document + mark-image tools            | `src/tools/documents.ts`        | read the `document-retrieval` skill first             |
| Worker wiring (syncs, databases, pacers, tools) | `src/index.ts`                  | rarely                                                |
| Resilience / state / change detection / xlsx    | `src/engine/`                   | **almost never** — read the `sync-engine` skill first |

`README.md` is the developer overview; `ONBOARDING.md` is the no-code guide
for legal users (keep it no-code); `ARCHITECTURE.md` is the human-facing
technical reference (sources, sync model + hourly cadence, resilience,
quickstart, outage runbook) — keep architecture there, not in the README.

USPTO + TMview ship live and **keyless** (both discover by owner name); the
counsel-docket adapter is live but config-gated (`DOCKET_INBOX_PAGE_ID` +
`NOTION_API_TOKEN`, plus `config.docketClientNumber` for the wrong-client
guard); IP Australia and EUIPO are official overlays — enrichment of TMview
rows, never row-defining; `spend.example.ts` is a stub the adopter implements.

## Rules that prevent breakage

1. **After any schema change, run the backfill before the delta.** A deploy
   that changes columns makes the delta crash on startup (empty logs) until
   the backfill's replace write applies the migration:
   `ntn workers sync trigger portfolioBackfill`, then the delta provisions.
   Adding a column travels in lockstep across `buildSchema` (`src/schema.ts`)
   and the row builders (`src/join.ts`); the fingerprint covers it
   automatically because each row's basis _is_ its built properties — which
   is also why `Last Sync` is added only **after** the basis is captured. And
   blank absent values explicitly (the `Builder.richText("")` pattern) so
   incremental upserts clear stale data.

2. **Select options are pre-declared generously on purpose** (31 offices, all
   45 Nice classes) — adding an option later is a schema migration, which
   jams the delta until the manual backfill runs. For a new country, extend
   `OFFICE_OPTIONS` (`schema.ts`) and `COUNTRY_TO_OFFICE`
   (`counsel-docket.ts`) together.

3. **A derivation-rule change with unchanged inputs needs a re-emit trigger.**
   Bump `DERIVATION_VERSION` in `src/engine/fingerprint.ts` — it's folded
   into every fingerprint, forcing a one-time full re-emit. (E.g. you change
   how `Next Deadline` is computed: the raw data didn't change, so without a
   bump the delta thinks nothing changed.) It also keys the cached
   counsel-docket parse, so a parser fix without a bump keeps serving the
   stale parse.

4. **Never write user-space properties from the sync.** Managed-schema
   columns are read-only to workspace users and tools; anything users or
   tools edit (notes, owners, the **Mark Image** files property) lives in
   user-space properties the sync must never name.

5. **Sync state has two size limits.** Saves over 256KB are rejected; worse,
   a run _fails to start_ (instant exit, empty logs) when handed state above
   ~200KB. Snapshots are gzipped; project payloads at the fetch boundary to
   only fields the join reads. Each delta logs `packed snapshots <N>B` — keep
   it well under ~150KB. (See the `sync-engine` skill.)

6. **Pacers: the platform caps a worker at 5, and tools get none.** The four
   here are shared across all syncs and probes, deliberately tiny for the
   WAF-fronted keyless backends — never widen them casually. A tool's
   `execute` cannot use `worker.pacer` (`.wait()` throws outside the sync
   runtime), so the tools self-throttle instead — e.g. `attach` moves **one
   document per call** against TSDR's separate ~4/min PDF budget.

7. **Per-execute time budget is ~5 minutes.** Per-item enrichment must be
   budgeted or rotated across cycles — TMview's per-mark detail fetches are
   capped per cycle and converge; a spend adapter must chunk the same way.
   (See `sync-engine`.)

## Operational gotchas

- **`ntn login` for Notion auth** — the base template needs no
  `NOTION_API_TOKEN` (only the Docket Inbox, `attach`, and `refreshMarkImages`
  do). Don't `source .env` before running `ntn` — an exported `NOTION_*`
  token can shadow the CLI's own auth ("unauthorized").
- **The keyless backends are WAF-fronted and undocumented.** Blocks can
  outlast a day (hence the 7-day staleness caps), and the deadliest failure
  is a challenge page that parses as a valid _empty_ result — both adapters
  treat zero raw hits as a block and throw, never return `{}`. TMview also
  **silently ignores** unknown request fields (a misshapen body looks fine,
  just unfiltered) — verify body changes against real result counts.
- **HTTP 200 doesn't mean success.** The Notion API can answer 200 with an
  `{"object":"error"}` body — the inbox listing treats that as a failure, not
  an empty inbox. Keep that check when touching `counsel-docket.ts`.
- **Icons and mark images decay.** `refreshMarkImages` re-uploads them; run
  it **locally** (`ntn workers exec refreshMarkImages --local`) because
  TMview's thumbnail endpoint often blocks datacenter egress, and re-run it
  after a backfill — replace-mode re-emits clear tool-set icons.
- **Probes must stay cheap (single-request)** — a probe that walks the full
  enrichment path starves the shared pacers and looks like scraping. The one
  deliberate exception is `probeCounselDocket`, which dry-runs the entire
  listing → download → parse → validate path: the sync's failure mode is
  _silent by design_ (a bad report keeps the previous parse serving), so this
  red health row is how a bad or misnamed report gets noticed.
- **Local verification writes nothing:**
  `ntn workers exec portfolioDelta --local` prints the rows a run would
  produce. Pass state with `-d '{"state":{...}}'`.

## Conventions

- Two-space indentation (Prettier). `module: nodenext` → **relative imports
  need `.js`** extensions (`import { x } from "./engine/state.js"`).
- Row keys: US serial | ST13 | `DKT-{office}-{number}`. Office codes are WIPO
  ST.3-style everywhere (`COUNTRY_TO_OFFICE` maps counsel's country names
  onto them).
- The backfill is **strict** (any row-defining source failure throws before
  emitting); the delta is **resilient** (serves last-known-good on outage).
  Never make the backfill resilient — it would mark-and-sweep live rows on
  partial data. Overlays and spend are enrichment: never cycle-fatal, even in
  strict mode.
- Deadlines are statutory **estimates** — extensions and grace periods are
  deliberately not modeled (overdue means "look into it"), counsel's docketed
  dates override them, and dead marks get none.
- Status bucketing: descriptor keywords only **disambiguate** a dead state,
  never establish one — a live registration in a cancellation proceeding must
  not bucket as Cancelled.

## Deep references (skills)

- **`sync-engine`** — resilience, state-size discipline, change detection,
  resolution budgeting. Read before touching `src/engine/` or adding per-item
  enrichment.
- **`source-adapter`** — the `UsCase` / `ForeignMark` / `OfficialOverlay`
  contracts and how to write a new source. Read before adding an office or
  register.
- **`docket-inbox`** — the two report formats, the filename convention,
  every validation guard, and how to adapt the parsers to a different firm's
  export. Read before touching `src/sources/counsel-docket.ts`.
- **`document-retrieval`** — how the three tools work (the TSDR file wrapper,
  the ~4/min PDF budget, mark-image validation and upload) and why tools
  can't use the sync pacers. Read before editing `src/tools/`.
