# Worker sync: Patent portfolio

Sync a company's patent filings from the **US (USPTO)** and **European (EPO)**
patent offices into managed Notion databases — grouped into families, kept
current automatically, and resilient to a patent office API going down. You can
also connect your own docketing and e-billing systems. Built on the
[Notion Workers](https://developers.notion.com/workers/get-started/overview) platform.

> **Not a developer?** This example doubles as a no-code product for legal and
> IP-operations teams. Start with **[ONBOARDING.md](ONBOARDING.md)** — a
> step-by-step setup guide (getting API keys, running `/setup` from an AI coding
> assistant, building views) that needs no terminal. The rest of this README is
> the developer-facing overview.

## What you get

Two managed databases, maintained by three syncs:

| Database             | Sync                | Mode        | Schedule     |
| -------------------- | ------------------- | ----------- | ------------ |
| **Patent Portfolio** | `portfolioBackfill` | replace     | manual       |
| **Patent Portfolio** | `portfolioDelta`    | incremental | hourly       |
| **Sync Health**      | `healthSync`        | incremental | every 15 min |

You don't create the databases yourself — the worker declares the schemas and
Notion creates and manages them ("managed databases"). The backfill is the
authoritative full load (and schema migrator); the delta keeps the portfolio
current and serves last-known-good data through a brief office outage; the
health sync writes a per-endpoint status table you can watch for outages.

## What it demonstrates

- A **multi-source sync** that joins two patent-office APIs into one managed
  database, grouping applications into families from public continuity data.
- **Source resilience** — last-known-good snapshots keep a previously seeded
  delta consistent through a brief office outage (a strict backfill vs. a
  resilient delta with a 24-hour staleness cap).
- **Frozen write-side pagination** — both syncs acquire once, then emit bounded
  batches from the same compressed snapshot without refetching between pages.
  EPO Register discovery exhausts the office-reported total and fails closed if
  its shared request or wall-clock budget cannot return the complete portfolio.
- **On-demand agent tools** — `listProsecutionDocuments` and
  `attachProsecutionDocumentToPage` fetch file-wrapper PDFs onto Notion pages.

## Prerequisites

- Node.js 22+ and the [`ntn` CLI](https://ntn.dev)
  (`curl -fsSL https://ntn.dev | bash`)
- A Notion workspace with Workers enabled (a Business or Enterprise feature)
- At least one free API key — **USPTO** and/or **EPO**. One office is enough to
  start; add the other later. See [ONBOARDING.md](ONBOARDING.md) for the exact
  steps (USPTO needs a USPTO.gov account verified with ID.me; EPO needs a
  developer account that is approved before it issues keys).

## Run it

```bash
npm install
cp .env.example .env          # add your US and/or EPO keys
# set PORTFOLIO_APPLICANTS in .env, and turn off any office you don't have
# keys for (config.sources.uspto / .epo — keep at least one on)
npm run check                 # type-check
ntn login                     # connect your Notion workspace
ntn workers deploy --name patent-portfolio-sync   # create databases + capabilities
ntn workers env push --yes    # upload your keys to the worker
ntn workers sync trigger portfolioBackfill   # initial full load
```

## Expected result

On the first run the worker creates two managed databases in your workspace —
**Patent Portfolio** (your applications and grants, grouped into families) and
**Sync Health** (one row per enabled patent-office endpoint) — and fills them
from the offices you enabled. The delta then keeps them current every hour;
re-running the backfill also mark-and-sweeps rows that have disappeared
upstream.

Discovery is name-based. USPTO's base query uses the first-named applicant and
the Patent File Wrapper dataset covers public applications filed after January
1, 2001; configure every known applicant-name variant and do not treat this
template as a complete ownership search. `Est. Expiry` is a baseline statutory
term estimate, not a docketing deadline; authoritative adjustments and legal
events require your docketing or advanced-enrichment data. It stays blank when
a grant or a term-bearing continuity filing date is absent rather than guessing
from a later application date.

## Verify it

- **Offline:** `npm run check` type-checks the project and `npm test` runs the
  focused change-detection and snapshot-serialization tests — no network or
  credentials needed.
- **Dry run:** `ntn workers exec portfolioBackfill --local` prints the exact
  rows a run would emit, without writing to Notion.
- **Deployed:** watch `ntn workers sync status` until the syncs report healthy,
  then open the **Patent Portfolio** database.

## Project layout

```
src/config.ts     ← source toggles, database title, optional docket rule
src/schema.ts     Notion columns + row builders
src/join.ts       the join / assembly (buildPortfolioRows)
src/index.ts      worker wiring (syncs, databases, pacers, tools)
src/engine/       reusable: resilience, state, http timeouts, fingerprint, pdf
src/sources/      uspto, epo (live); docketing, spend (example stubs)
src/tools/        optional on-demand document-retrieval tools
```

The docketing and spend adapters are intentionally fail-loud stubs. Keep their
source toggles off until you implement them; enabling an untouched stub throws
instead of recording a healthy empty result. Docket lookups should prefer
jurisdiction-qualified keys such as `US:17123456` and `EP:16730001`; bare keys
are accepted only when they identify one fetched jurisdiction.

## Customize and extend

Everything here is customizable. For the deep dive, see
**[ARCHITECTURE.md](ARCHITECTURE.md)** (sources, sync model, resilience design,
outage runbook) and **[DEVELOPMENT.md](DEVELOPMENT.md)** (the patent-specific
rules that keep the engine from breaking). If you use an AI coding assistant,
the `.claude/` directory
ships guided routines — `/connect-source` (add docketing, e-billing, or another
office like WIPO or the JPO), `/customize-schema`, and
`/add-advanced-enrichment`. Patent-specific engine, source, enrichment, and
document guidance lives under [`domain-guides/`](domain-guides/);
`.claude/skills` points to the cookbook's generated canonical Worker skills.

## Learn more

- **[ONBOARDING.md](ONBOARDING.md)** — no-code setup guide for legal / IP-ops users
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — technical reference and customization
- **[DEVELOPMENT.md](DEVELOPMENT.md)** — patent-specific adaptation rules
- **[domain-guides/](domain-guides/)** — detailed patent implementation guides
- **[AGENTS.md](AGENTS.md)** — generated canonical Worker guidance
- [Notion Workers documentation](https://developers.notion.com/workers/get-started/overview)
