---
name: workflow-validate
description: Review Notion Worker workflows for trigger typing, unstable step order, non-serializable results, swallowed failures, secret handling, and duplicate side effects
user-invocable: true
disable-model-invocation: true
allowed-tools: ["Read", "Glob", "Grep", "Bash"]
---

## Instructions

Review workflow definitions under `src/workflows/` and any modules they call. Read `.agents/skills/workflow-guide/SKILL.md` before starting, then inspect the installed workflow and trigger declarations.

Report findings by severity. For every finding, include the file and line, production impact, and a concrete fix. Do not invent issues when the code is already safe.

### Critical

1. A file does not default-export `createWorkflow(...)`, is nested below `src/workflows/`, or relies on a key that differs from its filename.
2. A trigger-specific event field is accessed without valid narrowing.
3. A step result is not JSON-serializable or later code relies on an in-memory mutation that will be absent when the step replays.
4. Step order can change between equivalent executions because of conditional calls, unstable iteration, or non-deterministic branching.
5. Any non-deterministic operation occurs outside a step, whether its result can vary or its external effect depends on whether it runs. This includes relevant I/O, mutable external state, current time, randomness, generated identifiers, messages, notifications, creates, updates, and action-style calls.
6. Two steps can have the same name within one run. Repeated operations should include a stable entity ID or an index from a collection returned by an earlier step.
7. A non-idempotent side effect can be duplicated on retry without a downstream idempotency key or equivalent guard.
8. Errors from external requests are ignored or swallowed, causing failed work to be reported as successful.
9. Credentials are hard-coded, committed, or logged.

### Warnings

10. A step is not awaited.
11. A step name is vague, does not identify the operation, or derives an index from data that was not returned by an earlier step.
12. A callback returns more data than later code needs, especially large or sensitive payloads.
13. Required environment variables are read without a clear missing-configuration error.
14. An HTTP response is consumed without checking `response.ok` or an accepted status.
15. Multiple triggers are declared but their paths do not share a cohesive behavior or are not exhaustively handled.

After the review, run `npm run check` and `npm run build` when dependencies are installed. Distinguish implementation findings from environment or dependency failures.
