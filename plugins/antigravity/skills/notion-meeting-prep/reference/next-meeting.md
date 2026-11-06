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

When Notion calendar tools are available for this workflow, do not use connector
search, including for meeting context. Use calendar details, linked materials,
and Notion-only retrieval. If neither calendar route is usable, ask for meeting
details rather than inferring current attendance or timing from indexed documents.

## Select the event

Use the current time and the user's timezone. Start with the primary calendar
and the next 12 hours, unless the user specifies a calendar or period. Exclude
canceled or declined events, focus time, breaks, out-of-office blocks, and office
or availability calendars. Prefer accepted meetings or meetings the user organizes;
for an accepted-only request, exclude tentative and unanswered invitations.
An accepted optional invitation still qualifies; exclude optional attendance only
when the user asks for required meetings only.
Do not infer attendance or meeting type from a title alone when event metadata
is available.

Choose the earliest qualifying start after now. If the initial window has no
qualifying event, widen once to the next seven days. Honor pagination needed to
establish the earliest match. If no meeting qualifies, say which period was
checked and ask for an event or date rather than scanning more calendars.
For overlapping qualifying events, use the user's stated preference, such as
1:1s or meetings they organize. Otherwise ask which event to prepare for when
both are plausible; do not silently assign importance by meeting size.

## Create a useful note and show it early

For requested Notion output, create or reuse the meeting note before
additional research. Reuse an identified existing note without creating another;
preserve its content and manually added attendees. Start with the event's known
purpose and duration, suggested timed topics, and sections for decisions and
actions. Do not invent project context or commitments. For example:

- **1:1:** priorities, feedback, support, growth, and next steps.
- **Status:** progress, blockers, decisions needed, and owners.
- **Customer:** objectives, questions, risks, and next steps; omit internal strategy.
- **Decision:** options, trade-offs, and decision criteria.

Include the event link, time, attendees, and initial agenda at creation whenever
the tool supports them together. Prefer automatic attendee mapping from the event;
otherwise reuse known Notion identities or resolve emails, batching lookups when
supported. Preserve RSVP distinctions: invited does not mean accepted or present.
Keep unresolved names/emails in the note instead of inventing user IDs or silently
dropping people. Do not invite users, change calendar RSVPs, or grant access.

Check returned attendee data against the event. Repair omissions with a targeted
update when identities are known, preserving manually added attendees. If the
response omits attendee data, use a required content/schema fetch to check it too;
otherwise make one focused verification read. Report unresolved mappings without
blocking the initial agenda or repeating identity searches.

Separate event discovery from event linking. A direct Google or Outlook connection
can find an event without connecting that account to Notion Calendar. In that
case, reuse a known note or create a note without `calendarEvent`, including its
title, time, attendee details, agenda, and event URL in the supported fields.
State that the note is not calendar-linked. Do not fabricate Notion Calendar
account IDs or retry a known-disconnected link operation.

For a connected Notion Calendar event, `create_meeting_note` takes `calendarEvent`
without `parent`, `title`, or `content`; it returns a new or existing note. Open
the returned note if it is not already visible, then add the agenda with a targeted
update. Fetch only when required by the tool or needed to preserve existing
content; reuse that read for attendee verification. If creation accepts the
agenda, show it using the same already-visible check. Follow the main skill's
panel guidance and accurately distinguish requesting a panel from confirmed
opening. Do not wait for research or recreate a note if opening fails.

## Improve the same note with focused research

Start with event details already returned. Use a detailed calendar lookup only
if it exposes additional needed information; do not repeat a listing that already
contains it. Read relevant descriptions, attachments, and linked notes before
searching. Use the meeting title, series, and attendee identities from the event;
resolve identity only where ambiguous.

For remaining context gaps, run independent Notion searches for previous notes
and relevant project context in parallel. When Notion calendar tools are available,
never call connector search. Otherwise use connected sources only for a specific
remaining gap. Fetch the most recent relevant prior note and up to three promising
context sources, batching independent reads and reusing content already available.
Stop when this pass provides enough context or returns no useful evidence; do not
repeatedly rephrase empty queries. A targeted follow-up is appropriate for a
material unresolved fact such as conflicting decision status.

Update the same note while it is open: add supported context, unresolved actions,
and source references, and replace suggested prompts where evidence makes them
more specific. Combine changes into one targeted update where possible. Preserve
user edits and completed actions; re-read if concurrent changes make the saved
state uncertain. With no useful results, state what was searched and retain the
initial agenda rather than generating another one. Respect search coverage notices.

Keep destination, audience, and uncertain-write checks from the main workflow.
Chat-only requests stay in chat; this early-save sequence does not authorize a
Notion write for them.
