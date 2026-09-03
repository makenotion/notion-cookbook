---
description: Add, remove, or rename columns in the Trademark Portfolio database
---

Help the user change the portfolio's columns. In this template a column
change travels across **two places** — schema and builder — and the
fingerprint follows the builder automatically.

For each column being added:

1. **Schema** — add it to `buildSchema` in `src/schema.ts` with the right
   `Schema.*` type (title/richText/date/number/select/multiSelect/checkbox/
   url). Property order is column order. **Declare select options
   generously:** adding an option later is a schema migration, and a schema
   migration jams the delta until the manual backfill runs — that's why all
   45 Nice classes and a wide office list are pre-declared even though a real
   portfolio uses a handful. Feature-gated columns belong behind their toggle
   (see the `counselDocket` / `spend` spreads).
2. **Builder** — set the value in `buildUsRow` / `buildForeignRow` /
   `buildDocketOnlyRow` in `src/join.ts` (all three if the column applies to
   every row kind). For values that should clear when absent (a met deadline,
   a recovered status), write an explicit empty — `Builder.richText("")` —
   rather than omitting the property: incremental upserts leave unspecified
   properties untouched, so an omitted value strands the stale one.
3. **Fingerprint — automatic here.** Each row's `fingerprintBasis` is its
   built properties, captured before `Last Sync` is stamped — a column you
   emit in a builder joins change detection by itself, and `Last Sync`
   advances only on real changes (so never emit a volatile per-run value). If
   you changed how an existing column is _computed_, bump
   `DERIVATION_VERSION` in `src/engine/fingerprint.ts` — it's folded into
   every fingerprint (forcing a one-time full re-emit) and doubles as the
   counsel-docket parser version, so cached report parses re-run too.

Where the value comes from:

- Already-fetched source data → map it in the adapter's projection
  (`projectTmsearchHit` / `parseTsdrCase` in `src/sources/uspto.ts`,
  `projectMark` in `src/sources/tmview.ts`) onto `UsCase` / `ForeignMark`,
  then into the builder.
- A new upstream field → extend the fetch/projection at the boundary (for
  tmsearch, add it to `TMSEARCH_SOURCE_FIELDS` too) — and mind the state-size
  discipline (see `domain-guides/sync-engine/SKILL.md`): whatever you keep rides in the
  delta's snapshots forever.

**User-space vs managed:** managed-schema properties are read-only to
workspace users and to tools. Columns people (or agent tools) should edit —
notes, owners, file uploads — belong in user-space properties added in the
Notion UI, which the sync never touches. **"Mark Image" is deliberately
user-space** (created by the `refreshMarkImages` tool, not the schema) so
uploaded images survive re-emits — don't "fix" it into the schema; that would
make it unwritable.

After editing: `npm run check`, then `ntn workers exec portfolioDelta --local`
to confirm the column populates. On deploy, **run the backfill before the
delta** (schema migration), and expect a one-time full re-emit if you bumped
`DERIVATION_VERSION`.
