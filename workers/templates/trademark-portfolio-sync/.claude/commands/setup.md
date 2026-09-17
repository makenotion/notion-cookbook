---
description: Guided onboarding — deploy your trademark portfolio, no API keys required
---

You are walking a new user through setting up this trademark-portfolio worker.
They may not be a developer. Be warm, explain each step in one sentence, and
**ask rather than assume**. Use your interactive question UI for choices.
Don't run destructive commands without confirming.

The headline, and this template's difference from its patent sibling: **the
base setup needs no API keys at all.** USPTO search and TMview are keyless —
the user sets their owner name(s) and deploys. Everything else is an optional
upgrade added later, each independently. Don't send them off to register for
anything unless they opt into an upgrade.

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

## 2. Owner name(s) — the one input that matters

Ask for the company name(s) **exactly as recorded as owner/applicant** with
trademark offices — this string drives discovery in both the USPTO search
backend and TMview, and "Acme Corporation" vs "Acme Corp." returns different
portfolios. Help them pin down the exact string: look up one US mark they know
in TSDR (https://tsdr.uspto.gov — the owner of record on the case), or search
by owner at https://tmsearch.uspto.gov; for foreign filings, check the
applicant field on a mark in TMview (https://www.tmdn.org/tmview). Write the
name(s) into `ownerNames` in `src/config.ts` — they can list several (former
names, subsidiaries, holding entities). Leave `config.sources` at the
defaults: `uspto` + `tmview` on, everything else off.

## 3. API keys — none required

Tell them the good news and move on: unlike most office APIs (and the patent
template), there is nothing to register for, no `.env` to fill in, no approval
email to wait on. The one exception: if they **already hold a TSDR API key**,
create `.env` from `.env.example` and set `TSDR_API_KEY` now — it upgrades US
rows to same-day freshness and enables the document tools. Don't make them go
get one today; it's step 8's first upgrade. Never echo a key back.

## 4. Check and test

Run `npm run check` (types) and `npm test` (offline parser/engine tests — no
network or credentials needed). Both must pass before going further.

## 5. Smoke-test discovery (no Notion writes yet)

Run `ntn workers exec portfolioBackfill --local` and confirm it returns rows
for their marks. If it throws "zero hits", the owner name probably doesn't
match office records — help them adjust the spelling or add name variants to
`ownerNames`. (Both keyless backends sit behind WAFs; if a corporate VPN or
datacenter network is in play, try another network before concluding the name
is wrong.)

## 6. Deploy

`ntn login` (they confirm the workspace), then `ntn workers deploy` to create
the **Trademark Portfolio** and **Sync Health** databases plus the syncs. If
they created a `.env` in step 3, push it — the deploy does NOT upload it:
`ntn workers env push --yes`; with no keys there's nothing to push. Then
`ntn workers sync trigger portfolioBackfill` for the initial full load (this
also applies the schema). Watch `ntn workers sync status` until healthy.

## 7. Verify

`ntn workers sync status` healthy, then open **Sync Health**: within its first
15-minute cycle it shows one row per enabled source (**USPTO search**,
**TMview**) reading "Up". That database — not `sync status` — is the ongoing
outage signal, because the hourly delta serves cached data during outages and
still reports healthy. Finally, open the portfolio together and spot-check a
few marks they know.

## 8. Optional upgrades — offer, in order of value

Tell them the baseline already tracks identity, status, classes, deadlines,
and lapse risk worldwide. Then offer the upgrades as opt-ins (multi-select):

1. **TSDR key (free)** — same-day US freshness plus the file-wrapper document
   tools (office actions, specimens, registration certificates). Key from
   https://account.uspto.gov/api-manager/, then
   `ntn workers env set TSDR_API_KEY=…`. It's read at run time — the next
   cycle upgrades with no redeploy, and a "USPTO TSDR (keyed)" health row
   appears.
2. **Docket Inbox** — outside counsel's docket/properties reports as a
   drag-and-drop source: exact docketed deadlines override the estimates,
   lapse instructions the registers can't know, and rows for direct national
   filings no registry API enumerates. Run `/add-docket-inbox`.
3. **Mark images** — real thumbnails + page icons. Run the `refreshMarkImages`
   tool **locally** (TMview's thumbnail endpoint blocks datacenter egress):
   set `NOTION_API_TOKEN` in `.env` (integration connected to the portfolio
   database), then `ntn workers exec refreshMarkImages --local -d '{"maxImages":25}'`,
   repeating with `startCursor` set to each `nextCursor` until `hasMore` is
   false. Re-run after every backfill — re-emits clear page icons (see the
   `domain-guides/document-retrieval/SKILL.md`).
4. **Official overlays** — authoritative AU / EU statuses and renewal dates
   from IP Australia and EUIPO (free accounts, but each needs approval — EUIPO
   especially can lag). Run `/connect-source`.
5. **Spend** — per-mark legal cost from their e-billing system (a stub they
   implement). Run `/connect-source`.

## 9. Wrap up

Run `/deploy-checklist`. Point them at the **Sync Health** database as their
outage signal, and remind them the delta runs hourly from here on — the
backfill is manual, re-run after schema changes or to sweep deleted marks.
