# Phase 2 — Agent skills, sync robustness, and team onboarding

## Overview

Goal: Turn this fork into a team-friendly starter for Notion + agents: make agent tools usable (Notion queries, worker tools), harden syncs (Linear, GitHub), and add onboarding automation so teammates can run and extend examples quickly.

## Top priorities (biggest wins)

1. Agent tool readiness (high impact, quick wins)
   - Deploy or document how to deploy the most useful Worker tools as agent-callable tools (chart-generator, github-draft-release-tools, postgres-query).
   - Add step-by-step “Add to Agent” and example tool-call snippets in each worker README.

2. GitHub & Linear syncs: local dev + safety (high impact)
   - Ensure github-sync and linear-sync have clear local-preview commands and example `.env` files (verify & add `.env.example` entries).
   - Add a lightweight install script and a small CI job that runs each worker's `npm run check` and tests on PRs.

3. Team onboarding and runbook (medium impact)
   - Add a top-level install-and-run script and a short checklist in README: clone → `npm install` → `cp .env.example .env` → local preview commands.
   - Add a CONTRIBUTING quick section specifically for adding skills and Workers (follow AGENTS.md).

4. Automation & validation (medium impact)
   - Add an npm script to install all project deps (or enhance existing scripts) and a repository-level `verify:all` run in CI.
   - Create a pre-PR checklist template and a PR template for workers and skills.

5. Observability & safety (longer-term)
   - Add example logs/monitoring guidance for Workers.
   - Add explicit guidance about read-only agent tools, bounds, and authentication in AGENTS.md.

## Deliverables for Phase 2 initial bootstrap
- `docs/PHASE-2.md` (this document)
- `scripts/bootstrap.sh` (optional): installs root deps and runs per-project installs for selected workers (linear-sync, github-sync, chosen tools).
- `.github/PULL_REQUEST_TEMPLATE.md` (short review checklist)
- `.github/workflows/ci-phase2.yml` (CI job that runs repo `verify:all` or the subset for workers included)
- README updates: short “Getting started for team” section linking to this plan and showing common commands.

## Immediate action items (phase 2 first PR)
- [ ] Add this Phase 2 plan (doc added in this branch)
- [ ] Add `scripts/bootstrap.sh` that runs `npm install` and per-project `npm install` for linear-sync and github-sync
- [ ] Add `.github/PULL_REQUEST_TEMPLATE.md` with checklist: run `npm run check`, `npm test`, `npm run verify:all` where relevant
- [ ] Add lightweight CI workflow running `npm ci` and `npm run verify:all` (or a subset) on PRs
- [ ] Small README excerpt with team quickstart commands

## Acceptance criteria for Phase 2 bootstrap
- PHASE-2.md merged and reviewed by at least one maintainer
- CI validates that `npm run check` and `npm test` succeed for `linear-sync` and `github-sync`
- Follow-up PRs created for each deliverable (or converted to platform-tracked issues if you enable Issues later)

## Notes about issues & tracking
This repository currently has GitHub Issues disabled. Because you asked not to enable repo-level settings, I will not enable Issues here.

Options for tracking Phase 2 items (choose one):
- Keep tracking inside this repo via PRs and the PHASE-2.md checklist (current approach).
- Use a separate tracking repo (I can create issues there if you provide the repo name), or create a Notion page that lists these items (I can add a Notion page via a Worker or provide markdown to paste).
- Use GitHub Discussions or Projects if you prefer — I can create a Discussions draft or a Project board instead.

Please tell me which tracking option you prefer (I will not enable repo Issues without explicit permission).
