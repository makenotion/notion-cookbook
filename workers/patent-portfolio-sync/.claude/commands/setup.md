---
description: Guided onboarding — connect your sources and deploy your patent portfolio
---

You are walking a new user through setting up this patent-portfolio worker.
They may not be a developer. Be warm, explain each step in one sentence, and
**ask rather than assume**. Use your interactive question UI for choices.
Don't run destructive commands without confirming.

Work through these steps, pausing for the user at each input:

## 1. Prerequisites — confirm BEFORE anything else

Required; don't proceed past this step until they check out. Run the checks in
parallel (silently), then walk the user through only the missing pieces.

- **Node.js ≥ 22:** run `node --version`. If missing or older, install the LTS
  (which satisfies ≥ 22) — `nvm install --lts`, or download from
  https://nodejs.org. Offer to install it for them.
- **`ntn` CLI:** run `ntn --version`. If missing, install with
  `curl -fsSL https://ntn.dev | bash`.
- **macOS only — Xcode command line tools:** run `xcode-select -p`. If it
  errors, run `xcode-select --install` (a popup installs them; ~10 min). Many
  developer tools depend on these.
  If anything is absent, stop and help install it before continuing — if a
  command errors, ask the user to paste the full terminal output rather than
  guessing. Once the checks pass, run `npm install`.

## 2. Applicant name(s)

Ask for the exact applicant/assignee name(s) as registered with patent
offices (e.g. "Acme Corporation"). This drives USPTO + EPO discovery. Write
them into `applicants` in `src/config.ts`. Mention they can list several.

## 3. Which offices — then keys (only what they have)

Ask which patent offices they want to track now: **US (USPTO)**, **Europe
(EPO)**, or **both**. They need **at least one** — they can add the other
later by re-running this step. Set `config.sources` in `src/config.ts` to
match: `uspto`/`epo` true only for the office(s) they chose (keep ≥ 1 true).

Create `.env` from `.env.example` if absent, then collect keys **only for the
enabled office(s)**:

- **USPTO** (if enabled): free key from the **Open Data Portal (MyODP)** —
  register for ODP access at
  https://data.uspto.gov/support/universal-registration → `USPTO_API_KEY` in `.env`.
  Two things to flag for them: (a) MyODP (data.uspto.gov) is a _different_ site
  from the older **MyUSPTO** (my.uspto.gov) — easy to confuse; (b) USPTO
  requires a **USPTO.gov account verified with ID.me** before it issues a key
  (one-time; verifying can take a few minutes). Once verified, the key is
  issued instantly.
- **EPO** (if enabled): free developer account at https://developers.epo.org
  (Non-paying access), then **My Apps → Add a new App** (Core APIs) yields a
  consumer key + secret → `EPO_CONSUMER_KEY` / `EPO_CONSUMER_SECRET`. Flag the
  contrast with USPTO: EPO needs **no identity verification**, but the account
  must be **approved by EPO (confirmation email) before keys can be created** —
  not instant, so suggest they start this early. If they're setting up today
  and the EPO email hasn't arrived, they can enable USPTO now and add EPO later.
  Leave the disabled office's keys blank. Confirm `.env` is gitignored (it is).
  Do NOT echo their keys back.

## 4. Smoke-test discovery (no Notion writes yet)

Run `ntn workers exec portfolioBackfill --local` and confirm it returns rows
for their applicant. If zero rows, the applicant name probably doesn't match
office records — help them adjust it. If a source errors, check that office's
key (or, if they don't have it yet, turn the office off in `config.sources`).

## 5. Docketing & spend (optional)

Ask whether they want to connect their docketing system (links offices into
families, adds docket numbers) and/or their e-billing/spend system now. For
each "yes", run `/connect-source`. For "no", leave the stub — the portfolio
works on public office data alone.

## 6. Advanced enrichment (optional) — ASK explicitly

Tell them the baseline tracks identity, status, grants, and patent term
(expiry estimates). Then offer the advanced set as an opt-in and ask
which they want (multi-select):

- INPADOC family IDs (worldwide family grouping, an audit signal)
- JP/CN/WO grant detection + adverse legal events (via OPS family data)
- Forward-citation counts (renew-vs-prune value signal)
- US term & prosecution fields (PTA, Track One, art unit, terminal
  disclaimer, maintenance-fee schedule / Next Renewal Due)
- EP orphan audit (EP filings missing from your docket) — needs docketing
  If they pick any, run `/add-advanced-enrichment` with their selections.

## 7. Deploy

`ntn login` (they confirm the workspace), then `ntn workers deploy` to create
the **Patent Portfolio** and **Sync Health** databases plus the syncs.
**Push the keys to the deployed worker** — the deploy does NOT upload `.env`:
`ntn workers env push --yes` (uploads the local `.env`). Only then
`ntn workers sync trigger portfolioBackfill` for the initial full load (this
also applies the schema; without the keys it would fail). Watch
`ntn workers sync status` until healthy.

## 8. Wrap up

Run `/deploy-checklist`. Point them at the **Sync Health** database as their
outage signal, and remind them the delta runs hourly from here on.
