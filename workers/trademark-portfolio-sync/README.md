# Worker sync: Trademark portfolio

Sync a company's global trademark portfolio into managed Notion databases —
US filings from the **USPTO**, everything else from **TMview**, joined with
your outside counsel's docket reports — with computed deadlines across the
whole prosecution and renewal lifecycle, and resilience to a registry going
down. **The base template needs no API keys at all**: set your owner name(s)
in `src/config.ts` and deploy. Built on the
[Notion Workers](https://developers.notion.com/workers/get-started/overview) platform.

> **Not a developer?** This example doubles as a no-code product for in-house
> legal and legal-ops teams. Start with **[ONBOARDING.md](ONBOARDING.md)** — a
> step-by-step setup guide (finding your owner name, running `/setup` from an
> AI coding assistant, connecting your counsel's docket reports, building
> views) that needs no terminal. The rest of this README is the
> developer-facing overview.

## What you get

Two managed databases, maintained by three syncs:

| Database                | Sync                | Mode        | Schedule     |
| ----------------------- | ------------------- | ----------- | ------------ |
| **Trademark Portfolio** | `portfolioBackfill` | replace     | manual       |
| **Trademark Portfolio** | `portfolioDelta`    | incremental | hourly       |
| **Sync Health**         | `healthSync`        | incremental | every 15 min |

You don't create the databases yourself — the worker declares the schemas and
Notion creates and manages them ("managed databases"). The backfill is the
authoritative full load (and schema migrator); the delta keeps the portfolio
current and serves last-known-good data through an upstream outage; the health
sync writes a per-source status table you can watch — including a row that
dry-runs the counsel-docket parse so a bad report goes visibly red.

## What it demonstrates

- **Keyless-first syncing** — USPTO search and TMview need no credentials;
  every key (TSDR, IP Australia, EUIPO) is an optional, independent upgrade
  read at run time — set the env var and the next cycle upgrades, no redeploy.
- **A global portfolio in one database** — US rows, TMview rows refined by
  official office overlays, and counsel-only filings, each with a per-row
  Office and Jurisdiction.
- **A docketing integration with no API** — counsel's docket/properties
  reports (`.xlsx`) dragged onto a Notion "Docket Inbox" page, parsed inside
  the worker by a zero-dependency xlsx reader: exact deadline dates,
  allow-to-lapse flags, and filings no registry aggregator indexes — behind
  validation guards that refuse the wrong file.
- **A deadline engine** — Next Deadline + Deadline Type span office-action
  responses, the Statement of Use lattice, opposition windows, §8 / §9
  maintenance, and per-office renewals; counsel's docketed dates beat every
  estimate.
- **Source resilience** — a strict backfill vs. a resilient delta,
  last-known-good snapshots with per-source staleness caps, and
  fingerprint-gated delta writes.
- **On-demand agent tools** — `listTrademarkDocuments`,
  `attachTrademarkDocumentToPage`, and `refreshMarkImages` fetch file-wrapper
  documents and mark images onto Notion pages.

## Prerequisites

- Node.js 22+ and the [`ntn` CLI](https://ntn.dev)
  (`curl -fsSL https://ntn.dev | bash`)
- A Notion workspace with Workers enabled (a Business or Enterprise feature)
- **No API keys.** Unlike this template's patent sibling, both launch sources
  are keyless — you can deploy in the time it takes to type your company's
  name. TSDR, IP Australia, and EUIPO credentials are optional upgrades you
  add later, one at a time (see [ONBOARDING.md](ONBOARDING.md)).

## Run it

```bash
npm install
# set your owner name(s) in src/config.ts — the only required customization
npm run check                 # type-check
ntn login                     # connect your Notion workspace
ntn workers deploy --name trademark-portfolio-sync   # create databases + capabilities
ntn workers sync trigger portfolioBackfill           # initial full load
```

That's the whole setup — no keys to paste. Later, any optional key or the
Docket Inbox settings go in `.env` (`cp .env.example .env`, then
`ntn workers env push --yes`); each is read at run time — no redeploy. Verify
locally anytime with `ntn workers exec portfolioBackfill --local` (prints the
rows a run would emit, writes nothing), and offline with `npm test`.

## Customize

Everything here is customizable. For the deep dive, see
**[ARCHITECTURE.md](ARCHITECTURE.md)** (sources, the sync model, the
resilience design, outage runbook) and **[AGENTS.md](AGENTS.md)** (the rules
that keep the engine from breaking). If you use an AI coding assistant,
`/setup` in the `.claude/` directory is the guided onboarding, and the skills
there document the engine internals, the source-adapter contract, the
counsel-docket formats, and the document tools.

## Runbook

- **A keyless source is blocked past its 7-day staleness cap** (the
  WAF-fronted USPTO search and TMview backends): exempt it while pushing
  fresh data from the healthy sources —
  `ntn workers env set STALENESS_CAP_EXEMPT=tmview` (or `uspto`), trigger
  `portfolioDelta`, then `ntn workers env unset STALENESS_CAP_EXEMPT`.
- **After any schema change, run the backfill**
  (`ntn workers sync trigger portfolioBackfill`) — the delta can't start
  until the backfill's replace write applies the migration.
- **Mark images or page icons decay** — re-run the mark-image tool:
  `ntn workers exec refreshMarkImages --local` (locally, because TMview's
  thumbnail endpoint often blocks datacenter egress). Re-run it after a
  backfill too: replace-mode re-emits clear tool-set icons.
- **Pause / resume syncing** (e.g. while reworking the schema):
  `ntn workers sync pause portfolioDelta`, then
  `ntn workers sync resume portfolioDelta`.

## Layout

```text
src/config.ts     ← the main thing you customize (owner names, sources, docket client #)
src/schema.ts     Notion columns (generous select vocabularies on purpose)
src/join.ts       the join / assembly, row builders, and the deadline engine
src/index.ts      worker wiring (syncs, databases, pacers, tools)
src/engine/       reusable: resilience, state, http timeouts, fingerprint, xlsx
src/sources/      uspto, tmview, counsel-docket, ipaustralia, euipo (live); spend (stub)
src/tools/        optional on-demand tools: documents + mark images
```

## Learn more

- **[ONBOARDING.md](ONBOARDING.md)** — no-code setup guide for legal / legal-ops users
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — technical reference and customization
- **[AGENTS.md](AGENTS.md)** — context and rules for AI coding assistants
- [Notion Workers documentation](https://developers.notion.com/workers/get-started/overview)
