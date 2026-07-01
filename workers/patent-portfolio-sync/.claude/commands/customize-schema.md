---
description: Add, remove, or rename columns in the Patent Portfolio database
---

Help the user change the portfolio's columns. The critical rule: **a column
change travels in lockstep across three places** — miss one and it silently
won't work.

For each column being added:

1. **Schema** — add it to the `base` object in `buildSchema` in `src/schema.ts`
   with the right `Schema.*` type (title/richText/date/number/select/checkbox/
   url/relation). Select options must be non-empty.
2. **Builder** — set the value in `buildAppProperties` (and/or
   `buildFamilyProperties`) in the same file. Only emit it when present, and
   for values that should clear when absent (e.g. a status that recovered),
   write an explicit empty (`Builder.richText("")`) rather than omitting it —
   incremental upserts leave unspecified properties untouched.
3. **Fingerprint** — make sure the underlying value is part of the row's
   `fingerprintBasis` in `src/join.ts`. If it comes from a `PatentRecord`
   field already in the basis, you're done; if it's newly derived, add it. If
   you changed how an existing column is _computed_ (not its inputs), bump
   `DERIVATION_VERSION` in `src/engine/fingerprint.ts` to force a re-emit.

Where the value comes from:

- Already-fetched source data → map it in the relevant `src/sources/*` adapter
  onto `PatentRecord`, then into the builder.
- A new upstream field → you may need to extend the adapter's fetch/projection
  (mind the state-size discipline — see the `sync-engine` skill).

After editing: `npm run check`, then `ntn workers exec portfolioDelta --local`
to confirm the column populates. On deploy, **run the backfill before the
delta** (schema migration), and expect a one-time full re-emit if you bumped
`DERIVATION_VERSION`.
