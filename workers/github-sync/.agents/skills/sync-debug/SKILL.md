---
name: sync-debug
description: Diagnose a failing or misbehaving sync — fetch run logs, identify errors, cross-reference with code, and suggest fixes
user-invocable: true
disable-model-invocation: true
allowed-tools: ["Read", "Bash", "Glob", "Grep", "Edit", "Write"]
---

## Instructions

Help the user figure out why their sync is failing or producing wrong results. Work through the steps below systematically.

### Step 1: Get Current State

Run these commands to understand the situation:

```shell
ntn workers sync status
```

Note which syncs are listed, their status, last run time, and next scheduled run. Look for syncs that are stuck, failing, or haven't run recently.

### Step 2: Fetch Recent Runs

```shell
ntn workers runs list
```

Look for runs with non-zero exit codes (shown in red in table output). Note the run IDs for failed runs.

### Step 3: Get Logs

For the most recent run (any capability):

```shell
ntn workers runs list --plain | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}
```

For the most recent run of a specific sync:

```shell
ntn workers runs list --plain | grep <syncKey> | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}
```

Read the full log output. Look for error messages, stack traces, and any `console.log` output from the sync code.

### Step 4: Read the Sync Code

Read `src/index.ts` (and any imported modules) to understand the sync's logic. Cross-reference the error from the logs with the code.

### Step 5: Diagnose

Common failure patterns and their fixes:

**API Authentication Errors (401/403)**

- Check if OAuth is configured: `ntn workers oauth token <oauthKey>`
- Check environment variables: `ntn workers env list`
- If env vars are missing remotely: `ntn workers env push`
- If OAuth token expired: `ntn workers oauth start <key>` to re-authenticate

**Rate Limiting (429)**

- Reduce batch size in the sync code
- Add delays between API calls if needed
- Check if the API has documented rate limits

**Timeout / Long Execution**

- The execute function is taking too long per call
- Reduce batch size (fewer records per page)
- Simplify per-record processing (defer heavy transforms)

**Cursor / State Errors**

- TypeError on state access: probably a first-run issue (state is undefined)
- State shape changed after a code update: the persisted state from the previous run has the old shape
- Fix: `ntn workers sync state reset <key>` to clear state and re-backfill from scratch

**Schema Mismatch**

- Properties in `changes` don't match the `schema.properties` definition
- Check that every key in the `properties` object of each change matches a key in the schema
- Check that `Builder.title()` is used for `Schema.title()` properties, `Builder.richText()` for `Schema.richText()`, etc.

**Infinite Loop (sync never completes)**

- `hasMore` is always `true` — the cursor isn't advancing
- Check that `nextState` changes between iterations
- Check the termination condition: is it reachable?

**Empty Results**

- API returning no data: test the API call directly (curl or local exec)
- Wrong endpoint or query parameters
- Auth working but insufficient permissions/scopes

**Network / Transient Errors**

- Single occurrence: may be transient — check if subsequent runs succeeded
- Repeated: check the API endpoint URL, DNS, connectivity
- Force a retry: `ntn workers sync trigger <key>`

### Step 6: Fix and Verify

After identifying the issue:

1. Apply the fix to the code
2. Run `npm run check` to verify types
3. If the state shape changed, warn the user they may need `ntn workers sync state reset <key>` (this triggers a full re-backfill)
4. Deploy and preview to verify: suggest `/sync-preview` or run `ntn workers deploy && ntn workers sync trigger <key> --preview`
5. When the fix is verified, `ntn workers sync trigger <key>` to resume
