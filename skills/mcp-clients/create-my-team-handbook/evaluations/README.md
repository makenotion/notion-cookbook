# Evaluation cases

Use the [collection protocol](../../evaluations.md) with stateful mock tools.
These are scenario specifications, not executed tests. Compare no-skill and
new-skill runs; the previous-skill condition is not applicable.

- `context-to-workspace.json`: context extraction, domain decisions, populated
  structure, evidence fidelity, and usable navigation.
- `preview-and-provenance.json`: preview-only scope, first-party references,
  and honest handling of inaccessible gallery layouts.
- `resume-limited-tools.json`: uncertain-write recovery, reuse, and useful
  fallback when databases and views cannot be created.

Supply current valid tool schemas; source bodies are available through fetch,
not injected as user instructions. Preserve writes in mock state for readback.
Resolve names only when a unique matching user exists; an unavailable match
should remain unassigned with the name retained in the body. For visual grading,
inspect a rendered disposable page when available and record whether that check
was performed. Judge navigation, density, hierarchy, and an obvious next action,
not exact heading strings or a fixed count of decorative elements.

## Visual design cases

- `visual-composition.json`: open gallery inspiration, coherent styling, useful
  first screen, and navigation with real content.
- `limited-design-capabilities.json`: text-only fallback, sparse information,
  and honest visual verification.

Existing first-party-only cases intentionally retain that restriction in their
user prompts: source selection must follow the particular user's request.
For visual runs, render persisted mock output in Notion or use a disposable test
workspace with authorization. Record desktop and narrow-screen observations;
do not count mock structural checks as proof of rendered beauty.

`default-private-destination.json` checks that an omitted destination uses the
connection's private default. Grade visual composition against the relevant
gallery patterns, not merely the presence of an icon, cover, or callout.

## Reference workspace replay

`reference-workspace.json` supplies a fictional brief for an authorized private
workspace. Give the runner only its query/context and the runtime skill; withhold
success criteria and existing sample page IDs. Record the first result, inspect
the saved views and relations, and walk the rendered workspace in Notion. Compare
workflow, hierarchy, visible metadata and detail-page usefulness against the
intended directory and request-desk composition, not exact prose or pixels.
Maintain two separate results: the best designed artifact and the independent
skill-execution result. UI-assisted refinement can establish the design benchmark
and its PNGs, but does not prove MCP-only reproduction. Record each UI adjustment,
the equivalent missing MCP capability, and whether that gap was verified or is
still suspected. Preserve the initial output and report retries and unavailable
checks. Do not lower the benchmark to match current tool support.
