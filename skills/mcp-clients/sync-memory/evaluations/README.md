# Sync Memory evaluations

Follow the [shared evaluation protocol](../../evaluations.md). These scenarios
check how the agent uses the skill and reports results. They are not executed by
`npm test` and are excluded from the installed plugin.

| Scenario                                                        | Main checks                                                                                                                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Full Markdown copy](full-markdown-copy.json)                   | Runs the bundled command, includes nested Markdown, preserves source text and paths, and reports inventory results without claiming byte-identical export. |
| [Unavailable or failed sync](not-ready-or-failed.json)          | Imports available Markdown without requiring a summary and reports partial progress or uncertain writes without blind retries.                             |
| [Onboarding and scheduled sync](onboarding-recurring-sync.json) | Delegates memory imports to Sync Memory and reuses an approved native local task with the same source, destination and mapping.                            |

Run each scenario with no skill, the previous skill, and the revised skill using
the same isolated source directory and Notion fixture. Compare the submitted
Markdown, page identity, attribution, and reported result. Keep personal memory
and production workspaces outside these evaluations.

The automated tests in `test/` separately cover package contents, real Codex
installation and discovery, file copying, write recovery, and the absence of lifecycle hooks.
Real Notion authentication and import rendering require separate live checks.
