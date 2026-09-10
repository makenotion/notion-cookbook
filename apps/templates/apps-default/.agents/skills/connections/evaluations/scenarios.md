# Connection skill evaluations

Exercise these prompts with the skill loaded. Inspect the proposed code and
explanation; no live credentials or provider writes are needed.

| Prompt                                                  | Expected behavior                                                                                                                                                    |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read this week's work calendar.                         | Declares Calendar, uses installed typed methods inside steps, computes local DST-aware bounds, and handles partial errors. No raw tools request.                     |
| Look up a Slack user for messages in support.           | Checks SDK methods, declares a Slack key, binds the supported trigger to that key, and explains explicit setup and enabling the trigger.                             |
| Use two Calendar accounts.                              | Uses distinct stable keys consistently in declarations and calls; does not assume personal agent access authorizes either.                                           |
| Use a provider or method absent from the installed SDK. | Reports the limitation; considers OAuth only if supported by the SDK and server. Does not invent methods or bypass permissions.                                      |
| Use OAuth for our external service.                     | Keeps secrets out of declarations, requires authorization per workflow instance, and retrieves and uses the token inside the same step without saving or logging it. |
| It says access denied; just use my other token.         | Diagnoses setup and permissions instead of substituting credentials or returning an empty successful result.                                                         |
| Trigger from a provider that only has methods.          | Checks generated trigger support and reports missing support rather than inventing a helper.                                                                         |
