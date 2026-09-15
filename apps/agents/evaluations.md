# App skill evaluation scenarios

Run these requests against a copied App template with the generated skills.
Inspect code and compile against the intended SDK version. Do not deploy or
use live credentials.

| Request                                                      | Expected observable outcome                                                                                                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a paginated issue sync                                   | Direct default export in src/syncs; attached database; primary key on sync and omitted from upsert properties; stable keys; cursor survives empty pages with a next cursor                              |
| Migrate a Worker tool and auth interceptor                   | Explains that Apps lacks those registration APIs; does not invent equivalent APIs or assume sync has workflow connections                                                                               |
| Read records through a provider connection                   | Declares the provider connection; uses its typed client inside steps; follows the method's input and result types; handles partial errors                                                               |
| Retry an uncertain provider write                            | Reconciles existing successful writes before retrying; uses idempotency only when supported by the method                                                                                               |
| Listen for Slack messages through a named support connection | Declares a Slack connection and binds its key using the typed trigger callback; rejects undeclared or wrong-provider keys and duplicate trigger/key pairs; distinguishes connection keys from step keys |
| Add an interactive issue board                               | Uses createCustomBlock, Apps React imports, root-owned dependencies, and separate browser tsconfig; schema declaration is distinguished from binding                                                    |
| Review a workflow with mutable step-local state              | Reports replay hazard with file, line, impact, and fix; returns needed values from steps; narrows trigger events                                                                                        |
