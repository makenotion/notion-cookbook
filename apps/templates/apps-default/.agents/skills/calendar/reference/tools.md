# Calendar tools for Apps workflows

All calls use the request pattern in [the skill](../SKILL.md). Field names
below describe the payload inside the tool-named key. `?` means optional.
Do not send fields marked optional as `null` unless null is explicitly allowed.

- [Shared shapes](#shared-shapes)
- [Read tools](#read-tools)
- [Event writes](#event-writes)
- [Scheduling-link writes](#scheduling-link-writes)

## Shared shapes

- `CalendarRef`: `{ accountId, calendarId }`, both strings. Get real IDs from
  `calendar_list_calendars`; do not guess them from an email or calendar name.
- `EventRef`: `{ calendar: CalendarRef, eventId, eventSummary? }`. Reuse
  IDs from returned events. An event ID alone is not enough.
- Timed period: `{ type: "DATE_TIME", start: { dateTime, timeZone? }, end:
{ dateTime, timeZone? } }`. Use ISO timestamps with offsets or `Z`, or include
  an IANA `timeZone` when using local date-times without offsets.
- All-day period: `{ type: "DATE", start: { date: "YYYY-MM-DD" }, end:
{ date: "YYYY-MM-DD" } }`. Preserve the provider's all-day end-date semantics;
  do not convert these dates to UTC instants.
- Attendee: `{ email, displayName?, isOptional? }`. Set names only when known
  and mark optional only when requested.
- Resource: `{ email?, displayName?, isOptional }`. Use a returned room from
  the same account as the event calendar.
- `TimeSlot`: `{ startAt, endAt }`, ISO timestamps.
- `SchedulingWindow`: `{ startDate, endDate, recurrence? }`, ISO timestamps with
  offsets. `recurrence` is an array of RRULE/EXDATE strings.
- `LinkIdentity`: `{ schedulingLinkId, bookingCalendarRef: CalendarRef }`.
  Get it by listing links first: use the returned link's `id` for
  `schedulingLinkId` and preserve its current `bookingCalendarRef`.

Read calendars and accounts are scoped by the connection on the server. There
is no `calendars` input for listing events, nor an `accountIds` input for listing
contacts. Do not copy private Calendar service `config` fields into the payload.

## Read tools

### `calendar_list_calendars`

Input: `{ onlyAccountEmails?: string[] }`; use `{}` for all permitted accounts.
Returns `accounts[]`, each with `calendars[]`. Use this to choose real calendar
references. An account email filter narrows access; it never grants access.

### `calendar_list_events`

Required: `timeMin`, `timeMax`, `timeZone`. Optional:
`includeDeclinedInvites` (boolean or null). The range must not exceed one month.
Returns `accounts[].calendars[].events`, `userPreferences`, and required
`errors[]` with `accountId`, `calendarId`, and `error`. Check errors even on HTTP
200; do not report partial results as a complete agenda.

### `calendar_list_contacts`

Input: `{ queries?: string[] }`; matches any query against names or emails.
Returns `accounts[].contacts[]`. Use it to resolve attendees before creating
invites. Ask when several contacts could match; never invent an email address.

### `calendar_list_coworkers_events`

Required: `coworkerEmails: string[]`, `timeMin`, `timeMax`, `timeZone`. Range:
at most one month. Uses the default calendar's account and needs coworker-read
permission. Returns `coworkers[]` with schedules and optional `errors[]`.
Some coworkers may be missing when their calendars cannot be read. Missing
access is not evidence that they are free.

### `calendar_suggest_meeting_times`

Required: `participantEmails: string[]`, `durationMinutes` (integer), `timeMin`,
`timeMax`, `timeZone`. Optional: `maxCount` (default 10, max 50),
`includeParticipantSchedules` (boolean). Range: at most one month. Resolvable
group emails expand to members. Needs a readable default calendar and
coworker-read access for its account.

Returns ranked `suggestions[]`, `usedFlexibleDuration`, and optional `errors[]`.
Each suggestion includes `startAt`, `endAt`, hard/soft conflict counts,
`availableParticipants`, `unavailableParticipants`, `softConflictParticipants`,
`unknownStatus`, and `conflictingEvents`. Check actual duration and conflicts;
a suggestion is not a promise that everyone is free. Apps workflows force
`includeParticipantSchedules` to false, so do not rely on `participantSchedules`.

### `calendar_list_calendar_resources`

Required: `timeSlots: TimeSlot[]`, `minCapacity` (integer), `timeZone`.
Optional: `maxCount` (default 20, max 40), `ignoreWorkingLocation` (boolean),
`calendar: CalendarRef`. Uses the supplied calendar or the default calendar;
needs coworker-read access for its account. Include the organizer in capacity
(e.g., two people for a one-on-one).

Returns `resultsBySlot[]` with `timeSlot` and `availableResources[]`, sorted by
increasing capacity. Rooms are account-scoped. Set `ignoreWorkingLocation`
only when searching outside the user's usual office is intended.

### `calendar_list_scheduling_links`

Input: `{ type?: "singleUse" | "multiUse" | "recurring" }`.
Returns `schedulingLinks[]` for permitted calendars: active, unexpired links
with upcoming time ranges. Each link includes `id`, `bookingCalendarRef`,
`status`, `timeRanges`, and may include `schedulingLinkUrl`. Use returned
identity fields for later edits or deletion, not a parsed URL slug.

## Event writes

All writes need permission with no pending confirmation requirement. Calendar
provider and organizer rules still apply. If the user is not the organizer,
only RSVP changes are always allowed; do not assume they can edit or cancel
someone else's event. Updates and cancellations notify attendees when present.
Keep batch successes when another item fails.

### `calendar_create_events`

Required: `timeZone`, `events[]`. Each event requires `summary` (nonempty) and
`period`. Optional event fields: `description`, `location`, `recurrenceRules`
(RRULE/EXDATE strings), `attendees`, `resources`, `calendar`,
`disableConferencing` (boolean). Omitting `calendar` needs a configured default
calendar. Be clear about the target calendar before sending invitations.

Returns `accounts[].calendars[].createdEvents[]` and optional `errors[]`.
Store returned event IDs for later changes and duplicate checks.

### `calendar_update_events`

Required: `timeZone`, `updates[]`. Each update is one of:

- `{ updateType: "RSVP", event: EventRef, rsvp: { responseStatus, comment? } }`.
  Status is `needsAction`, `accepted`, `declined`, or `tentative`.
- `{ updateType: "UPDATE", event: EventRef, update: { ... } }`.
  Allowed fields: `summary`, `description`, `location`, `recurrenceRules`,
  `period`, `attendees`, `resources`, `addConferencing` (boolean). Summary must
  be nonempty when supplied. Attendees and resources are replacement lists;
  preserve existing entries unless removal was requested. `addConferencing`
  only adds it when attendees exist and conferencing does not already exist.

Returns `updatedEvents[]` and optional `errors[]`. Use exact uppercase
`updateType` values. Resolve the intended recurring instance or series before
editing; do not guess an ID or assume the request has a series-scope flag.

### `calendar_cancel_events`

Required: `events: EventRef[]`. Returns `canceledEvents[]` and optional
`errors[]`. Confirm the intended events and recurrence scope before enabling
this write in a workflow. For another organizer's event, use an RSVP decline
instead when appropriate; do not present that as canceling the event for all.

## Scheduling-link writes

### `calendar_create_scheduling_link`

Required: `bookingCalendar: CalendarRef`, `duration` (integer minutes, at least
5), `timeRanges: SchedulingWindow[]`. Optional: `conflictCalendars`, `title`,
`description`, `type` (`singleUse`, `multiUse`, `recurring`), `alias`,
`useDefaultConferencing` (default true), `minLeadTime`, `maxLeadTime`,
`expirationDate` (ISO timestamp). Type is inferred from time ranges if omitted.
Alias must have 1–32 letters, numbers, hyphens, or underscores. Lead times are
in minutes; minimum is nonnegative, maximum is positive and greater than
minimum when both are set.

Needs write permission on the booking calendar and read permission on each
conflict calendar. Returns optional `schedulingLink` and optional `errors[]`.
Require the expected link before reporting success; do not assume HTTP 200
means a link was created.

### `calendar_update_scheduling_link`

Required: `identity: LinkIdentity`. Optional: `patch` (defaults to `{}`). List
links first to get their current identity. The patch can replace
`bookingCalendar`, `conflictCalendars`, `title`, `description`, `duration`,
`timeRanges`, `type`, `alias`, `useDefaultConferencing`, `minLeadTime`,
`maxLeadTime`, or `expirationDate`. Creation constraints still apply.

Omitted fields stay unchanged. Only `title`, `description`, `minLeadTime`,
`maxLeadTime`, and `expirationDate` can be cleared with null. Expiration must
be in the future when supplied. Updating time ranges without a type infers a
new type. Turning default conferencing off clears conferencing.

Needs write access to the current and replacement booking calendars, plus
read access to replacement conflict calendars. Returns optional
`schedulingLink` and optional `errors[]`; verify the expected link was returned.

### `calendar_delete_scheduling_links`

Required: `{ schedulingLinks: LinkIdentity[] }`. Returns
`deletedSchedulingLinkIds[]` and optional `errors[]`. List links first and use
each current booking calendar reference. Deleting a link stops future bookings;
it does not cancel meetings already booked through it.
