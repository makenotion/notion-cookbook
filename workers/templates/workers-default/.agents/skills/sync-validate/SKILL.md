---
name: sync-validate
description: Review a sync capability for common bugs — cursor advancement, pagination termination, state persistence, bi-modal correctness, consistency buffers, and deletion handling
user-invocable: true
disable-model-invocation: true
allowed-tools: ["Read", "Glob", "Grep", "Bash"]
---

## Instructions

Read the sync capabilities in `src/index.ts` (and any imported modules). For each sync found, run through the checklist below. Report findings grouped by severity.

Before starting, read `.agents/skills/sync-guide/SKILL.md` for the full sync concepts reference.

### Critical Issues (will break the sync or cause data loss)

1. **No pagination termination**: Does `hasMore` eventually become `false`? Look for: infinite loops where `nextState` doesn't advance, missing base cases, conditions that can never be met.

2. **Cursor doesn't advance**: Does `nextState` change between iterations? If the cursor is the same as the previous state, the sync will loop forever. Check that each execute call makes progress.

3. **Missing first-run handling**: When `state` is `undefined` (first run), does the code handle it gracefully? Look for: `state.cursor` without `state?.cursor`, property access on potentially undefined state.

4. **Batch too large**: Is the sync returning thousands of changes in one execution? Recommend batches of ~100. Large batches will fail.

5. **Replace mode when API supports change tracking**: If mode is `replace` (or unset — it defaults to `replace`), does the source API support `updated_at` filters, event feeds, or similar change tracking? If so, recommend switching to `incremental` to avoid re-fetching everything each cycle.

6. **State persistence misunderstanding**: In incremental mode, the cursor never resets between cycles. The next cycle starts exactly where the last one left off. Check for code that assumes a fresh start each cycle — this will cause records to be re-fetched or skipped permanently.

### Structural Issues (bi-modal correctness)

1. **Single-mode cursor for incremental sync**: Is the sync using the same cursor strategy for both backfill and delta? Unless the API sorts by `updated_at` and uses an opaque cursor (where one cursor naturally serves both), the sync should have a discriminated state union with separate backfill and delta phases.

2. **Missing backfill-to-delta transition**: For bi-modal syncs, how is the delta cursor seeded? It must come from a marker captured _before_ the backfill started (event anchor, timestamp with overlap), NOT from the last record in the backfill. Otherwise, changes during the backfill window are lost permanently.

3. **No overlap in transition**: When transitioning from backfill to delta, is there an overlap window (e.g., `backfillStartedAt - 5 minutes`)? Without overlap, records modified during the backfill but before the delta cursor starts are missed permanently.

### Warnings (may cause subtle data quality bugs)

1. **No consistency buffer**: For incremental syncs hitting eventually consistent APIs, the cursor should lag behind "now" by 10-60 seconds. Without this, the cursor can advance past records that haven't been indexed by the source API yet — those records are lost permanently since the cursor never resets.

2. **Timestamp cursor without tie-breaking**: If using `updated_at` as a cursor, can multiple records share the same timestamp? If yes (batch imports, bulk updates, low-resolution timestamps), recommend the keyset pattern: `(timestamp, id)` with a query like `WHERE ts > X OR (ts = X AND id > Y)`.

3. **Missing delete handling**: In incremental mode, are deletions handled? Check:
   - Does the source API have a delete signal (audit log, archived filter, events)?
   - If yes, is the sync emitting `{ type: "delete", key }` markers?
   - If the delete signal is on a separate endpoint, is the flip-flop pattern used (alternate streams at cycle boundaries)?
   - If no delete signal exists, should this be a replace-mode sync instead?

4. **Hardcoded secrets**: Are API keys, tokens, or credentials in the code instead of a brokered credential or `process.env`? Flag any string that looks like a secret.

5. **Missing error handling on fetch**: Network calls without error handling will crash the sync on any transient failure. Consider whether the sync should catch and handle API errors or let them propagate (the runtime will retry the cycle).

### Output Format

For each issue found:

- **What**: Name the issue and point to the specific code location
- **Why it matters**: What will happen in production if this isn't fixed
- **Fix**: Provide a concrete code snippet showing the fix

If no issues are found, say so. Don't invent problems.
