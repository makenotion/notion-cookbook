# Meeting prep evaluations

Follow the [shared evaluation protocol](../../evaluations.md) for fixture setup,
baseline comparisons, quality gates, usage measurements, and selection tests.
These scenarios are not instructions to load at runtime.

## Scenarios

| Fixture                                                        | Capability                  | Main checks                                                                  |
| -------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| [decision-meeting-prep.json](decision-meeting-prep.json)       | Full decision preparation   | Both requested documents, options, risks, evidence, and timed agenda         |
| [status-meeting-prep.json](status-meeting-prep.json)           | Status preparation          | Accurate task metrics and separate internal/external destinations            |
| [agenda-only.json](agenda-only.json)                           | Short internal agenda       | No unnecessary pre-read, retrieval, or writes                                |
| [post-meeting-update.json](post-meeting-update.json)           | Recurring meeting follow-up | Outcomes and actions preserved without unrequested tasks                     |
| [current-external-context.json](current-external-context.json) | Customer research           | Current external evidence, analysis, and audience separation                 |
| [save-draft.json](save-draft.json)                             | Saved draft                 | Draft status honors an explicit Notion destination                           |
| [discover-meeting-context.json](discover-meeting-context.json) | Project discovery           | Find current project, previous actions, and meeting destination              |
| [linked-actions.json](linked-actions.json)                     | Linked follow-up tasks      | Supported commitments, identity resolution, deduplication, and relations     |
| [partial-action-recovery.json](partial-action-recovery.json)   | Partial-write recovery      | Reuse persisted tasks and repair missing relations without duplicate creates |

## Retained capability coverage

Decision, status, brainstorm, sprint planning, retrospective, and 1:1 templates remain available. The four worked examples retain fuller project, executive, sprint, and customer workflows. Exercise each template and series organization with appropriate audience fixtures before a release.

## Acceptance

Require factual fidelity, requested scope, and correct persisted state before
comparing efficiency. Accept equivalent output structures and exposed tool names.
Review both full-workflow and short-request results on each tested model; do not
accept reduced token usage that drops requirements or weakens attribution.

## Access-check efficiency

Run the existing scenarios with all required tools exposed and no required access
probe, then with a tool that explicitly requires an access check. The first
condition should not add a routine probe; the second must honor the requirement
and reuse its result. Preserve source discovery, required reads, write warnings,
and uncertain-write recovery in both conditions. Record tool calls alongside
the original quality criteria.

## Next-meeting preparation

- [Accepted meeting and empty research](next-accepted-meeting.json): selection,
  parallel research, evidence-free agenda, split creation/update, and panel delivery.
- [Widen the calendar window](next-meeting-window.json): next working day,
  user-organized events, and chat-only output.
- [Overlapping meetings](next-meeting-overlap.json): clarify genuine ambiguity.
- [Existing meeting note](next-meeting-existing-note.json): choose recent evidence,
  preserve content, and avoid duplicate notes.

Serve calendar events only through calendar queries, honoring calendar, time,
attendance filters, and pagination. Serve search results and source bodies only
through their matching tools. Expose the stated creation contract in the tool
schema; return creation IDs only after a successful write. For the empty-window
case, also run a variant with no events in either window: the agent should stop
and ask for an event or date, without creating a note. Repeat the overlap case
with a stated 1:1 preference: it should select the 1:1 without clarification.
For separate creation/update tools, require a targeted update using the returned
ID; a fetch is necessary when existing content or required structure is unknown.
Repeat accepted-meeting selection with “required meetings only”: select the
later required 1:1 instead of the accepted optional review.
Retain the detailed decision and external-context cases to check that the quick
preparation budget does not truncate explicitly requested research.

## Calendar connection selection

[Calendar connection](calendar-connection.json) exposes both dedicated calendar
routes and connected content search. Serve access and account information only
through the corresponding tools, and events only through event queries. Run
these variants with identical event data:

- Notion and direct calendar both usable: use Notion only for event selection.
- Notion tools absent, access unavailable, or account not connected: use the
  direct connection without trying connected content search for events. Use
  [disconnected calendar](disconnected-calendar.json) to verify an unlinked note
  with the event URL, no `calendarEvent`, and accurate disclosure.
- Access and account already known: reuse them without another discovery check.
- A successful empty Notion event response: widen the time window on the same
  connection rather than probing the direct calendar.
- User explicitly chooses the direct connection: honor that choice.
- Neither route usable: ask for meeting details without searching indexed content
  for a purported next meeting or creating a guessed event-linked note.

Connector search must not be called at any stage when Notion calendar tools are
available.
These cases distinguish missing calendar access from missing meeting context.

## Early delivery and attendee preservation

Run [early delivery](early-delivery.json) with the actual Notion split
creation/content contract. Verify ordering from the trace: initial note and
panel request precede research; later findings update that same note. Preserve
user edits introduced after the panel request. Validate attendee mapping, RSVP
accuracy, and unresolved email handling without calendar writes or sharing.

Measure wall-clock time from the user request to the panel request, first useful
agenda, and final update separately. Confirm panel visibility separately from the
request. Record total elapsed time, including reasoning and time between calls;
summed tool durations are not end-to-end latency. Targets for routine preparation
are 15 seconds to a visible note, 30 seconds to a useful agenda, and 60 seconds to
completion; report actual results rather than treating targets as achieved.

## Reuse the open meeting note

[Already-open note](panel-already-open.json) supplies the open-page context through
the client and prior opening confirmation through conversation history. Require
zero panel calls while updating the same note, even across follow-up turns.
Also run with an explicit closed-panel state or a different visible page: the
agent may open the requested note once, then must not reopen it after updates.
An earlier authorization handoff alone is not evidence that a page is visible.
