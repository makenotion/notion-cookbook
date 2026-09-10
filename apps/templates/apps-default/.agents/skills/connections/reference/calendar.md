# Calendar query guidance

Use the installed typed Calendar client to discover methods and their exact
inputs and results. Calendar and Google Calendar are distinct SDK providers;
do not substitute one for the other based on their names.

- Get account and calendar IDs from `listCalendars({})`; never guess them from
  names or email addresses. Filters narrow existing access, not grant access.
- For “this week,” resolve the date in the requested IANA time zone inside a
  step. Compute local week boundaries with their own DST offsets. Do not use
  the server's local zone or add seven 24-hour days across a DST change.
- Use ISO timestamps with offsets or `Z`. A query's `timeZone` does not correct
  incorrectly computed bounds. Keep event, coworker, and meeting-time query
  windows within one month; use stable step keys for multiple windows.
- Check per-calendar or per-person errors where present. An unreadable
  calendar is not an empty agenda, and missing availability is not free time.
- Preserve all-day date semantics and full event/calendar identities from
  results. Resolve ambiguous attendees before using their addresses.
- Only use operations exposed by the installed client. Do not copy legacy
  Calendar write payloads into a raw tools request to bypass missing methods.

Return to [the connections skill](../SKILL.md) for setup and retry handling.
