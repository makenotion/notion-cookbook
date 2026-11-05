# Prepare for the next meeting

## Choose the calendar connection

Use Notion's dedicated calendar tools for event selection when they are available
for the relevant account. Reuse known tool access and connection information;
if the tools require an access check and none is in context, check once. Tool
exposure alone does not establish that an account is connected. Use calendar
listing when needed to identify the account and primary calendar, then query
events. Honor the user's explicit choice of connection.

If Notion calendar tools are absent, unavailable, or have no connection for that
account, use an available direct calendar connection, such as Google Calendar or
Outlook. Discover the relevant tool family once instead of trying broad content
searches to determine calendar availability. Do not query both connections for
the same schedule, or treat an empty event window as a disconnected account.
Use the actual tool's filters; if it returns events across calendars, filter the
results using calendar metadata rather than inventing a primary-calendar parameter.

Do not use connected content search to select an event when a suitable calendar
tool is available. Connected search remains useful for meeting context after
selection. If neither calendar route is usable, explain that the next event
cannot be reliably determined and ask for the meeting details; do not infer
current attendance or timing from indexed documents.

## Select the event

Use the current time and the user's timezone. Start with the primary calendar
and the next 12 hours, unless the user specifies a calendar or period. Exclude
canceled or declined events, focus time, breaks, out-of-office blocks, and office
or availability calendars. Prefer accepted meetings or meetings the user organizes;
for an accepted-only request, exclude tentative, unanswered, and optional events.
Do not infer attendance or meeting type from a title alone when event metadata
is available.

Choose the earliest qualifying start after now. If the initial window has no
qualifying event, widen once to the next seven days. Honor pagination needed to
establish the earliest match. If no meeting qualifies, say which period was
checked and ask for an event or date rather than scanning more calendars.
For overlapping qualifying events, use the user's stated preference, such as
1:1s or meetings they organize. Otherwise ask which event to prepare for when
both are plausible; do not silently assign importance by meeting size.

## Gather enough context

Use the event's title, series, attendee names, and email addresses for focused
queries. Resolve an ambiguous attendee identity before searching by that person;
do not add identity lookups when the event already supplies it.

Run independent searches for prior meeting notes, recent Notion context, and
relevant connected sources in parallel. Fetch the most recent relevant note for
the same series and up to three promising context sources, reusing content
already available. Carry forward unresolved actions, not completed ones.
Stop when this pass provides enough context or returns no useful evidence.
Do not repeatedly rephrase empty searches. A targeted follow-up is appropriate
only for a material unresolved fact, such as conflicting decision status;
explain that uncertainty if it remains unresolved. Respect search coverage notices.

## Prepare and save

When no relevant context is found, state that no relevant prior material was
found in the searched sources. Use the known meeting purpose to propose questions:

- **1:1:** priorities, feedback, support, growth, and next steps.
- **Status:** progress, blockers, decisions needed, and owners.
- **Customer:** objectives, questions, risks, and next steps; omit internal strategy.
- **Decision:** options, trade-offs, and decision criteria.

Treat these as suggested topics, not facts about participants. If the purpose is
unclear, start by establishing the desired outcome. Fit the timed agenda to the
event's duration and leave sections for decisions and actions to capture during
the meeting; do not invent commitments.

For requested Notion output, reuse a note already linked to this event when
available, preserving existing content. Link a new note to the selected event
using the exposed tool schema. Provide the event and content together when
supported. If creation and content updates are separate, use the returned ID
and a targeted update; skip an intervening fetch only when the response or tool
contract guarantees the structure needed for that update. Retain the main
workflow's destination, audience, and uncertain-write checks. Show the saved
note using the skill's panel-delivery guidance; chat-only requests stay in chat.
