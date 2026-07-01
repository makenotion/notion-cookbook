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
- **Source resilience** — last-known-good snapshots so one office outage never
  blanks the portfolio (a strict backfill vs. a resilient delta).
- **Write-side pagination** — both syncs emit changes in bounded batches, and
  the EPO register search pages through all results rather than truncating.
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
# set your applicant name(s) in src/config.ts, and turn off any office you
# don't have keys for (config.sources.uspto / .epo — keep at least one on)
npm run check                 # type-check
ntn login                     # connect your Notion workspace
ntn workers deploy --name patent-portfolio-sync   # create databases + capabilities
ntn workers env push --yes    # upload your keys to the worker
ntn workers sync trigger portfolioBackfill   # initial full load
```

## Expected result

On the first run the worker creates two managed databases in your workspace —
**Patent Portfolio** (your applications and grants, grouped into families) and
**Sync Health** (one row per source) — and fills them from the offices you
enabled. The delta then keeps them current every hour; re-running the backfill
also mark-and-sweeps rows that have disappeared upstream.

## Verify it

- **Offline:** `npm run check` type-checks the project and `npm test` runs the
  change-detection and snapshot tests — no network or credentials needed.
- **Dry run:** `ntn workers exec portfolioBackfill --local` prints the exact
  rows a run would emit, without writing to Notion.
- **Deployed:** watch `ntn workers sync status` until the syncs report healthy,
  then open the **Patent Portfolio** database.

## Project layout

```
src/config.ts     ← the main thing you customize (applicant, sources, docket rule)
src/schema.ts     Notion columns + row builders
src/join.ts       the join / assembly (buildPortfolioRows)
src/index.ts      worker wiring (syncs, databases, pacers, tools)
src/engine/       reusable: resilience, state, http timeouts, fingerprint, pdf
src/sources/      uspto, epo (live); docketing, spend (example stubs)
src/tools/        optional on-demand document-retrieval tools
```

## Customize and extend

Everything here is customizable. For the deep dive, see
**[ARCHITECTURE.md](ARCHITECTURE.md)** (sources, sync model, resilience design,
outage runbook) and **[AGENTS.md](AGENTS.md)** (the rules that keep the engine
from breaking). If you use an AI coding assistant, the `.claude/` directory
ships guided routines — `/connect-source` (add docketing, e-billing, or another
office like WIPO or the JPO), `/customize-schema`, and
`/add-advanced-enrichment` — plus skills documenting the engine internals.

## Learn more

- **[ONBOARDING.md](ONBOARDING.md)** — no-code setup guide for legal / IP-ops users
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — technical reference and customization
- **[AGENTS.md](AGENTS.md)** — context and rules for AI coding assistants
- [Notion Workers documentation](https://developers.notion.com/workers/get-started/overview)
