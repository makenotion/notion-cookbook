# Setup evaluations

Follow the [shared evaluation protocol](../../evaluations.md) for fixture setup,
baseline comparisons, and quality gates. These scenarios are not instructions to
load at runtime.

| Fixture                                  | Capability              | Main checks                                                |
| ---------------------------------------- | ----------------------- | ---------------------------------------------------------- |
| [after-install.json](after-install.json) | Setup after install     | Connection check, fetches the guide, waits for approval    |
| [auth-failure.json](auth-failure.json)   | Missing connection      | Asks to reconnect and stops                                |
| [no-web-access.json](no-web-access.json) | Guide fetch unavailable | Asks for the guide contents; no steps invented from memory |
