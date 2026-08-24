---
name: workflow-validate
description: Review Notion Worker Workflows for trigger typing and retry safety.
user-invocable: true
disable-model-invocation: true
---

# Workflow validation

Review every file in `src/workflows/` and any modules it calls. Report each
finding with its file, line, impact, and fix.

Treat these as errors:

1. A Workflow is not a direct file or does not default-export `createWorkflow`.
2. Trigger-specific event fields are used without type narrowing.
3. Non-deterministic work occurs outside an awaited step.
4. Step order or names can change between retries.
5. A step result is not JSON-serializable or later code needs an in-memory mutation.
6. A retry-sensitive write lacks an idempotency key or duplicate guard.
7. External failures are ignored, or credentials are hard-coded or logged.

Run `npm run check` and `npm run build` when dependencies are installed.
