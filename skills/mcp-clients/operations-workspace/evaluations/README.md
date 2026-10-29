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
