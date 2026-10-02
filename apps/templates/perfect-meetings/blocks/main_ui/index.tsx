import React from "react"
import { createRoot } from "react-dom/client"
import {
  customBlock,
  pages,
  type DataSourceQueryOptions,
  type NotionDataSourcePage,
} from "@notionhq/apps/custom-blocks"
import { NotionCustomBlock, NotionTokenScope } from "@notionhq/apps/react"
import "@notionhq/apps/nds.css"
import "./shadcn.css"
import "./style.css"
import "./dashboard.css"

import {
  dateRange,
  dayBounds,
  groupByCompany,
  layoutDay,
  pickMeeting,
  splitEmails,
  text,
  type DayEvent,
} from "./meeting"
import {
  COMPANIES_QUERY,
  PEOPLE_QUERY,
  RUNS_QUERY,
  deriveMeetings,
  deriveRuns,
  meetingsQuery,
  meetingsWindowStart,
} from "./derive"
import {
  idleSync,
  initialQuery,
  reduceQuery,
  reduceSync,
  type QueryEvent,
  type QueryState,
  type Snapshot,
  type SyncEvent,
  type SyncRequest,
} from "./live"
import {
  PREP,
  RUN,
  RESEARCHING_LINE,
  attendeeCopy,
  blockState,
  latchPopulated,
  runStartedMs,
  researchPhase,
  researchProgress,
  type BlockState,
  type BlockStateInput,
} from "./state"

import { SetupPanel } from "./setup"
import { Button } from "./components/ui/button"
import { Badge } from "./components/ui/badge"
import { Card, CardContent } from "./components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs"
import { ActivitySummary, EmptyMeetings, SyncAction } from "./dashboard"
import { calendarStatus } from "./dashboardState"
import { PersonCard, CompanyCard } from "./profiles"

const HOUR_MS = 60 * 60 * 1000
const HOUR_PX = 48
const STATE_KEY = "perfect-meetings:view"

type Mode = "next" | "day"
/** Which view is showing; `selectedId` is a meeting opened from the day view. */
type ViewState = { mode: Mode; selectedId: string | null }
type Picked = NonNullable<ReturnType<typeof pickMeeting>>

/** Current time, refreshed every 30 seconds. */
function useNow(): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/** View state kept in localStorage, or only in memory when the sandbox blocks storage. */
function useViewState(): [ViewState, (next: ViewState) => void] {
  const [state, setState] = React.useState<ViewState>(() => {
    try {
      const stored = JSON.parse(
        window.localStorage.getItem(STATE_KEY) ?? "null"
      ) as Partial<ViewState> | null
      if (stored?.mode === "next" || stored?.mode === "day")
        return {
          mode: stored.mode,
          selectedId:
            typeof stored.selectedId === "string" ? stored.selectedId : null,
        }
    } catch {
      // Fall through to the default.
    }
    return { mode: "day", selectedId: null }
  })
  const update = React.useCallback((next: ViewState) => {
    setState(next)
    try {
      window.localStorage.setItem(STATE_KEY, JSON.stringify(next))
    } catch {
      // Storage is unavailable; the state still lasts for this session.
    }
  }, [])
  return [state, update]
}

function byKey(
  rows: readonly NotionDataSourcePage[],
  key: string
): Map<string, NotionDataSourcePage> {
  return new Map(
    rows.map((row) => [
      text(row.propertiesByKey[key]).trim().toLowerCase(),
      row,
    ])
  )
}

const formatTime = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
const formatDay = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  })

function formatWhen(startMs: number, endMs: number, allDay: boolean): string {
  if (allDay) return `${formatDay(startMs)} · All day`
  return `${formatDay(startMs)} · ${formatTime(startMs)} – ${formatTime(endMs)}`
}

function relative(startMs: number, endMs: number, now: number): string {
  if (startMs <= now) return now < endMs ? "Happening now" : ""
  const minutes = Math.round((startMs - now) / 60_000)
  if (minutes < 60) return `Starts in ${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `Starts in ${hours} h` : ""
}

const ICONS = {
  sync: "M13.5 8a5.5 5.5 0 0 1-9.9 3.3M2.5 8a5.5 5.5 0 0 1 9.9-3.3M12.5 1.8v2.9H9.6M3.5 14.2v-2.9h2.9",
  back: "M9.5 3.5 5 8l4.5 4.5",
  alert: "M8 5v3.5M8 10.8v.2M8 1.8l6.5 11.4h-13Z",
  calendar: "M2.5 4.5h11v9h-11ZM2.5 7h11M5.5 2.5v3M10.5 2.5v3",
} as const

/** A 16px stroke icon that takes the surrounding text color. */
function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg
      className="icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  )
}

/** A quiet placeholder shaped like the content that is loading. */
function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      <span className="skeleton-line skeleton-title" />
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className="skeleton-line" />
      ))}
    </div>
  )
}

const PILL_THEMES: Record<string, string> = {
  [PREP.queued]: "gray",
  [PREP.researching]: "blue",
  [PREP.ready]: "green",
  [PREP.failed]: "red",
}

/** A meeting's header, then a card per outside company and per outside attendee. */
function MeetingCards({
  meeting,
  eyebrow,
  people,
  companies,
  peopleLoading,
  now,
}: {
  meeting: Picked
  eyebrow: string
  people: Map<string, NotionDataSourcePage>
  companies: Map<string, NotionDataSourcePage>
  peopleLoading: boolean
  now: number
}) {
  const { row, startMs, endMs, allDay } = meeting
  const attendees = splitEmails(
    text(row.propertiesByKey["Attendee emails"])
  ).flatMap((email) => people.get(email) ?? [])
  const groups = groupByCompany(attendees, (person) =>
    text(person.propertiesByKey["Company domain"])
  )
  const status = text(row.propertiesByKey["Prep status"])
  const copy = attendeeCopy(row, attendees.length, peopleLoading, now)
  const phase = researchPhase(row, now)

  return (
    <>
      <header className="header">
        <div>
          <div className="meta">{eyebrow}</div>
          <h2 className="title">
            {text(row.propertiesByKey.Title) || "Untitled meeting"}
          </h2>
          <div className="muted">{formatWhen(startMs, endMs, allDay)}</div>
          {phase === "researching" && (
            <p className="status-line research-line" role="status">
              {status === PREP.researching ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  {RESEARCHING_LINE}
                </>
              ) : text(row.propertiesByKey["Research status"]) === "Ready" ? (
                "Meeting prep queued"
              ) : (
                "Waiting for participant and company research"
              )}
            </p>
          )}
        </div>
        <div className="actions">
          {status && (
            <Badge
              variant="secondary"
              className="pill"
              data-theme={PILL_THEMES[status] ?? "gray"}
            >
              Prep {status.toLowerCase()}
            </Badge>
          )}
          <Button
            type="button"
            className="dashboard-sync"
            onClick={() => void pages.open(row.id, { mode: "center_peek" })}
          >
            Open prep
          </Button>
        </div>
      </header>

      {copy.kind === "loading" ? (
        <Skeleton lines={2} />
      ) : copy.kind === "message" ? (
        <p className="muted">{copy.text}</p>
      ) : (
        <>
          {copy.note && (
            <p className="note" data-theme="red" role="status">
              <Icon name="alert" />
              {copy.note}
            </p>
          )}
          {groups.length > 0 && (
            <section>
              <h3 className="section">Companies</h3>
              <ul className="profiles-grid">
                {groups.map((group) => (
                  <CompanyCard
                    key={group.domain}
                    domain={group.domain}
                    company={companies.get(group.domain)}
                    attendees={group.attendees}
                    now={now}
                  />
                ))}
              </ul>
            </section>
          )}
          <section>
            <h3 className="section">People</h3>
            <ul className="profiles-grid">
              {attendees.map((person) => (
                <PersonCard key={person.id} person={person} now={now} />
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  )
}

function hourLabel(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, {
    hour: "numeric",
  })
}

/** Today as a single calendar day, with the current or next meeting highlighted. */
function DayView({
  meetings,
  highlightId,
  now,
  onSelect,
}: {
  meetings: readonly NotionDataSourcePage[]
  highlightId: string | null
  now: number
  onSelect: (id: string) => void
}) {
  const day = dayBounds(now)
  const { allDay, timed } = layoutDay(meetings, day)
  const hours = Math.round((day.endMs - day.startMs) / HOUR_MS)
  const px = (ms: number) => ((ms - day.startMs) / HOUR_MS) * HOUR_PX
  const scroller = React.useRef<HTMLDivElement>(null)

  // Open scrolled to an hour before the highlighted meeting, or before now.
  const highlighted = timed.find((event) => event.row.id === highlightId)
  const anchorMs = highlighted?.topMs ?? now
  React.useEffect(() => {
    if (scroller.current)
      scroller.current.scrollTop = Math.max(0, px(anchorMs) - HOUR_PX)
    // Only on mount and when the day changes.
  }, [day.startMs])

  const className = (event: { row: NotionDataSourcePage; endMs: number }) =>
    [
      "event",
      event.row.id === highlightId && "event-highlight",
      event.endMs <= now && "event-past",
    ]
      .filter(Boolean)
      .join(" ")

  return (
    <>
      <header className="header">
        <div>
          <div className="meta">Today</div>
          <h2 className="title">{formatDay(day.startMs)}</h2>
          <div className="muted">
            {timed.length + allDay.length === 0
              ? "No meetings with outside attendees today."
              : `${timed.length + allDay.length} meeting${timed.length + allDay.length === 1 ? "" : "s"} with outside attendees`}
          </div>
        </div>
      </header>

      {allDay.length > 0 && (
        <div className="all-day">
          <span className="gutter-label">All day</span>
          <div className="all-day-events">
            {allDay.map((event) => (
              <button
                key={event.row.id}
                type="button"
                className={className(event)}
                onClick={() => onSelect(event.row.id)}
              >
                <span className="event-title">
                  {text(event.row.propertiesByKey.Title) || "Untitled meeting"}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="timeline" ref={scroller}>
        <div className="timeline-inner" style={{ height: hours * HOUR_PX }}>
          {Array.from({ length: hours }, (_, hour) => (
            <div key={hour} className="hour" style={{ top: hour * HOUR_PX }}>
              {hour > 0 && (
                <span className="gutter-label">{hourLabel(hour)}</span>
              )}
            </div>
          ))}
          <div className="events" data-theme="blue">
            {timed.map((event: DayEvent) => {
              const height = px(event.bottomMs) - px(event.topMs)
              const title =
                text(event.row.propertiesByKey.Title) || "Untitled meeting"
              const time = `${formatTime(event.startMs)} – ${formatTime(event.endMs)}`
              return (
                <button
                  key={event.row.id}
                  type="button"
                  className={`${className(event)}${height < 40 ? " event-compact" : ""}`}
                  title={`${title}, ${time}`}
                  style={{
                    top: px(event.topMs),
                    height: height - 2,
                    left: `${(event.column / event.columns) * 100}%`,
                    width: `calc(${100 / event.columns}% - 4px)`,
                  }}
                  onClick={() => onSelect(event.row.id)}
                >
                  <span className="event-title">{title}</span>
                  <span className="event-time">
                    {height < 40 ? formatTime(event.startMs) : time}
                  </span>
                </button>
              )
            })}
            {now >= day.startMs && now < day.endMs && (
              <div className="now" data-theme="red" style={{ top: px(now) }} />
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function Toolbar({
  view,
  onChange,
  action,
}: {
  view: ViewState
  onChange: (next: ViewState) => void
  action: React.ReactNode
}) {
  return (
    <div className="dashboard-toolbar">
      <div className="dashboard-navigation">
        {view.mode === "day" && view.selectedId && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Back to today"
            onClick={() => onChange({ mode: "day", selectedId: null })}
          >
            <Icon name="back" />
          </Button>
        )}
        <TabsList aria-label="Meetings view">
          <TabsTrigger value="day">Today</TabsTrigger>
          <TabsTrigger value="next">Next meeting</TabsTrigger>
        </TabsList>
      </div>
      {action}
    </div>
  )
}

/**
 * Starts a calendar catch-up by adding a Workflow runs row, the same as a
 * person adding one by hand. See reduceSync for when repeat clicks are
 * ignored and when the request ends.
 */
function useSyncRequest(latestRunId: string | null): {
  pending: boolean
  error: string | null
  request: () => void
} {
  // A ref, so a second click before React re-renders still sees the first.
  const state = React.useRef<SyncRequest>(idleSync)
  const [, rerender] = React.useState(0)
  const latest = React.useRef(latestRunId)
  latest.current = latestRunId
  const apply = React.useCallback((event: SyncEvent) => {
    const next = reduceSync(state.current, event)
    if (next !== state.current) {
      state.current = next
      rerender((n) => n + 1)
    }
  }, [])

  React.useEffect(() => {
    apply({ type: "latest", runId: latestRunId })
  }, [latestRunId, apply])

  const pending = state.current.status === "pending"
  React.useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(
      () => apply({ type: "tick", now: Date.now() }),
      5_000
    )
    return () => window.clearInterval(timer)
  }, [pending, apply])

  const request = React.useCallback(() => {
    if (state.current.status === "pending") return
    const now = Date.now()
    apply({ type: "click", now, latestRunId: latest.current })
    const failed = (message: string) => apply({ type: "failed", message })
    void pages
      .create({
        parent: { type: "data_source_key", key: "runs" },
        properties: {
          Name: {
            type: "title",
            title: [{ type: "text", text: { content: "Sync calendar" } }],
          },
          // Empty or "Run now" marks a request (src/workflows/lib/runs.ts).
          Trigger: { type: "select", select: { name: "Run now" } },
          Started: {
            type: "date",
            date: { start: new Date(now).toISOString() },
          },
        },
      })
      .then(
        (result) => {
          if (result.status === "error") failed(result.error.message)
        },
        (cause: unknown) =>
          failed(cause instanceof Error ? cause.message : String(cause))
      )
  }, [apply])

  return {
    pending,
    error: state.current.status === "idle" ? state.current.error : null,
    request,
  }
}

type Row = NotionDataSourcePage

/**
 * A live query that reports `loaded` only after its first real result and
 * keeps the previous rows while a changed query reloads (see reduceQuery).
 * Pass stable options; `attempt` changes only to retry after an error.
 */
function useLiveQuery(
  key: string,
  options: DataSourceQueryOptions,
  attempt: number
): QueryState<Row> {
  const identity = JSON.stringify(options)
  const [state, dispatch] = React.useReducer(
    reduceQuery as (s: QueryState<Row>, e: QueryEvent<Row>) => QueryState<Row>,
    undefined,
    () => initialQuery<Row>()
  )
  React.useEffect(() => {
    dispatch({ type: "resubscribe" })
    let last: Snapshot<Row> = { items: [], isLoading: false }
    const unsubscribe = customBlock.subscribeToDataSource({
      key,
      options: JSON.parse(identity) as DataSourceQueryOptions,
      onSnapshot: (snapshot) => {
        last = snapshot
        dispatch({ type: "snapshot", snapshot })
      },
    })
    const timer = window.setTimeout(
      () => dispatch({ type: "timeout", snapshot: last }),
      10_000
    )
    return () => {
      window.clearTimeout(timer)
      unsubscribe()
    }
  }, [key, identity, attempt])
  return state
}

function MeetingsBlock() {
  const now = useNow()
  const [view, setView] = useViewState()
  // Four live queries in all (see derive.ts). The window start changes once
  // a day, so the Meetings options are identical between renders.
  const windowStart = meetingsWindowStart(now)
  const [retries, setRetries] = React.useState(0)
  const retry = React.useCallback(() => setRetries((n) => n + 1), [])
  const meetingsQ = useLiveQuery(
    "meetings",
    React.useMemo(() => meetingsQuery(windowStart), [windowStart]),
    retries
  )
  const runsQ = useLiveQuery("runs", RUNS_QUERY, retries)
  const people = useLiveQuery("people", PEOPLE_QUERY, retries)
  const companies = useLiveQuery("companies", COMPANIES_QUERY, retries)

  const { meetings, hasPrepUpdated, hasPrepFinished } = React.useMemo(
    () => deriveMeetings(meetingsQ.items),
    [meetingsQ.items]
  )
  const { latestRun, successRuns } = React.useMemo(
    () => deriveRuns(runsQ.items),
    [runsQ.items]
  )
  const sync = useSyncRequest(latestRun?.id ?? null)
  const progress = researchProgress(meetings, now)

  const error =
    meetingsQ.error ?? people.error ?? companies.error ?? runsQ.error
  const runsError = runsQ.error
  const loaded = meetingsQ.loaded && runsQ.loaded
  const picked = pickMeeting(meetings, now)
  const peopleByEmail = byKey(people.items, "Email")
  const companiesByDomain = byKey(companies.items, "Domain")
  const peopleLoading = !people.loaded

  // Without real meeting rows the block cannot tell "none" from "failed".
  const meetingsKnown = meetingsQ.hasData
  const input: BlockStateInput | null =
    loaded && meetingsKnown
      ? {
          latestRun: runsError ? null : latestRun,
          successRuns,
          hasPrepUpdated,
          hasPrepFinished,
          meetingCount: meetings.length,
          progress,
          now,
        }
      : null
  // Either positive signal latches as soon as it loads, before the rest.
  const signal = hasPrepUpdated || hasPrepFinished
  const latch = React.useRef(false)
  // A block bound before Workflow runs was added cannot read runs; it keeps
  // the calendar UI rather than showing setup states it cannot track.
  latch.current =
    latch.current || signal || runsError !== undefined
      ? true
      : latchPopulated(false, input)
  const populated = latch.current
  const state: BlockState | null = populated
    ? { kind: "ready", noMeetings: meetings.length === 0 }
    : input && blockState(input)

  const cards = (row: Picked, eyebrow: string) => (
    <MeetingCards
      meeting={row}
      eyebrow={eyebrow}
      people={peopleByEmail}
      companies={companiesByDomain}
      peopleLoading={peopleLoading}
      now={now}
    />
  )

  // A query error is a small notice above the last good data, never a
  // replacement for it. With no good data yet it stands alone, with Retry,
  // instead of an empty state that would claim there are no meetings.
  const notice = error && (
    <div className="note" data-theme="red" role="alert">
      <Icon name="alert" />
      <span className="note-text">
        Couldn't refresh updates: {error.message}
      </span>
      <Button
        type="button"
        variant="outline"
        className="button note-action"
        onClick={retry}
      >
        Retry
      </Button>
    </div>
  )

  const calendar = calendarStatus(latestRun, sync.pending, runsQ, now)
  const dayItems = layoutDay(meetings, dayBounds(now))
  const emptyDay = dayItems.timed.length + dayItems.allDay.length === 0
  const showEmpty =
    state?.kind === "ready" &&
    (state.noMeetings ||
      (view.mode === "next" && !picked) ||
      (view.mode === "day" && !view.selectedId && emptyDay))
  const emptyState = (
    <EmptyMeetings
      status={calendar}
      onSync={sync.request}
      scope={
        view.mode === "day" && state?.kind === "ready" && !state.noMeetings
          ? "today"
          : "upcoming"
      }
      onNext={
        view.mode === "day" && picked
          ? () => setView({ mode: "next", selectedId: null })
          : undefined
      }
    />
  )

  let content: React.ReactNode
  if (error && !meetingsKnown) {
    content = notice
  } else if (!state || !meetingsKnown) {
    // Only before the first result of the session.
    content = <Skeleton />
  } else if (state.kind !== "ready") {
    return (
      <div className="card setup-shell">
        {notice}
        <SetupPanel
          state={state}
          sync={sync}
          queries={{ people, companies, meetings: meetingsQ }}
          now={now}
        />
      </div>
    )
  } else if (state.noMeetings) {
    content = emptyState
  } else if (view.mode === "day") {
    const selected = view.selectedId
      ? meetings.find((row) => row.id === view.selectedId)
      : undefined
    const range = selected && dateRange(selected.propertiesByKey.When)
    content =
      selected && range ? (
        cards(
          { row: selected, ...range },
          selected.id === picked?.row.id
            ? relative(range.startMs, range.endMs, now) || "Next meeting"
            : "Meeting"
        )
      ) : emptyDay ? (
        emptyState
      ) : (
        <DayView
          meetings={meetings}
          highlightId={picked?.row.id ?? null}
          now={now}
          onSelect={(id) => setView({ mode: "day", selectedId: id })}
        />
      )
  } else if (picked) {
    content = cards(
      picked,
      relative(picked.startMs, picked.endMs, now) || "Next meeting"
    )
  } else {
    content = emptyState
  }

  const hasNavigation = meetingsKnown && meetings.length > 0
  return (
    <Card className="dashboard">
      <Tabs
        value={view.mode}
        onValueChange={(mode) => {
          if (mode === "day" || mode === "next")
            setView({ mode, selectedId: null })
        }}
      >
        {hasNavigation && (
          <Toolbar
            view={view}
            onChange={setView}
            action={
              !showEmpty && (
                <SyncAction status={calendar} onSync={sync.request} />
              )
            }
          />
        )}
        <CardContent className="dashboard-content">
          {meetingsKnown && notice}
          {sync.error && (
            <p className="note" data-theme="orange" role="alert">
              Couldn't start a sync: {sync.error}
            </p>
          )}
          {hasNavigation ? (
            <TabsContent value={view.mode}>{content}</TabsContent>
          ) : (
            content
          )}
        </CardContent>
      </Tabs>
      <ActivitySummary
        people={people}
        companies={companies}
        status={calendar}
        now={now}
      />
    </Card>
  )
}

const root = document.getElementById("root")
if (!root) throw new Error("Missing root element")
createRoot(root).render(
  <NotionCustomBlock>
    <NotionTokenScope>
      <MeetingsBlock />
    </NotionTokenScope>
  </NotionCustomBlock>
)
