# Evaluation cases

Follow the [collection protocol](../../evaluations.md) using stateful mock tools.
These are scenario specifications, not executed behavioral tests. Compare the
new skill with no-skill runs; a previous version is not applicable.

- `brief-to-project.json`: source fidelity, actionable tasks, dependency handling,
  and a populated, readable project home.
- `reuse-project.json`: uncertain-write recovery, shared-task reuse, and accurate
  project filtering without duplicate projects or tasks.
- `preview-without-write.json`: preview-only scope and first-party provenance.
- `limited-tools.json`: useful page-only setup without invented features or work.

Serve sources through tools, preserve mutations in mock state, and map fixture
IDs to valid IDs when required. For the reuse case, expose query records through
fetch as well. Provide supported schemas consistently across compared runs.
Grade the resulting navigation, hierarchy, first action, and record fidelity;
record separately whether rendered appearance was inspected. Do not grade exact
headings, task counts unrelated to source coverage, or decorative elements.

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
