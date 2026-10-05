# Database designer evaluations

Follow the [shared evaluation protocol](../../evaluations.md). These are fixture
specifications, not a bundled runner or runtime skill instructions.

| Fixture                                                          | Capability         | Main checks                                                                |
| ---------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------- |
| [design-only.json](design-only.json)                             | Design advice      | Useful minimal schema, no writes or extra approval                         |
| [reuse-existing.json](reuse-existing.json)                       | Reuse and views    | Existing source of truth, correct filters, preserved records               |
| [create-with-limited-tools.json](create-with-limited-tools.json) | New database       | Correct parent and properties, honest unsupported-view reporting           |
| [lossless-migration.json](lossless-migration.json)               | Approved migration | Full pagination, mapped values, preserved content and relations            |
| [unmapped-values.json](unmapped-values.json)                     | Loss prevention    | Unmapped values retained, consequential mapping resolved before conversion |
| [uncertain-create.json](uncertain-create.json)                   | Recovery           | Verify existing database before retrying a timed-out create                |

Inspect persisted schemas, records, and view filters rather than accepting a
confident completion message. Grade data preservation and requested scope before
token or tool-call efficiency. Vary relation targets, read-only properties, and
unsupported operations in follow-up runs.
