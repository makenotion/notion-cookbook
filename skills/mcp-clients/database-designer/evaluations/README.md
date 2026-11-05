# Database designer evaluations

Follow the [shared evaluation protocol](../../evaluations.md). These are fixture
specifications, not a bundled runner or runtime skill instructions.

## Everyday outcomes

These cases test whether the assistant makes work easier to manage without asking
users to design database fields or choose technical implementations.

| Fixture                                                          | User outcome                      | Main checks                                                                                 |
| ---------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------- |
| [notes-to-tracker.json](notes-to-tracker.json)                   | Stop losing customer requests     | Useful populated tracker, repeated requests consolidated, original notes preserved          |
| [design-only.json](design-only.json)                             | Organize volunteer requests       | Simple suggested setup, no unrequested writes                                               |
| [reuse-existing.json](reuse-existing.json)                       | See which requests need attention | Reuse existing work, useful views, preserve customer context                                |
| [create-with-limited-tools.json](create-with-limited-tools.json) | Track borrowed equipment          | Correct setup, honest reporting of unavailable views                                        |
| [weekly-planner.json](weekly-planner.json)                       | Plan the week                     | Required reads kept, no search or access check, page written once, rows batched, board only |

## Reliability checks

| Fixture                                            | Capability                   | Main checks                                                                            |
| -------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| [lossless-migration.json](lossless-migration.json) | Simplify an existing tracker | All records covered, progress inferred faithfully, original values and notes preserved |
| [unmapped-values.json](unmapped-values.json)       | Loss prevention              | Unmapped values retained, consequential mapping resolved before conversion             |
| [uncertain-create.json](uncertain-create.json)     | Recovery                     | Verify existing database before retrying a timed-out create                            |

Inspect the populated tracker and its views, not just the completion message.
Grade usefulness, data preservation, and requested scope before token or tool-call
efficiency. Vary relation targets, read-only properties, and unsupported operations
in follow-up runs.

## Panel delivery

[panel-database](panel-database.json) starts with a creation request and checks automatic panel delivery in the same turn, without an explicit request to open the result. Also exercise link-only requests and panel-open failures: preserve the saved artifact, return its link, and do not claim an unsuccessful open succeeded.

Additional cases: [link-only request](panel-link-only.json) and [panel failure](panel-open-failure.json).
