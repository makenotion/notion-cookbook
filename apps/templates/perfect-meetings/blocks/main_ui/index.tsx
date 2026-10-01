import React from "react"
import { createRoot } from "react-dom/client"
import {
  customBlock,
  pages,
  type DataSourceQueryOptions,
  type NotionDataSourcePage,
  type NotionPageId,
} from "@notionhq/apps/custom-blocks"
import { NotionCustomBlock, NotionTokenScope } from "@notionhq/apps/react"
import "@notionhq/apps/nds.css"
import "./style.css"

import {
  dateRange,
  dayBounds,
  groupByCompany,
  layoutDay,
  pickMeeting,
  profileLinks,
  roleLabel,
  sortByStart,
  splitEmails,
  text,
  type DayEvent,
} from "./meeting"
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
  cardLine,
  canSync,
  latchPopulated,
  quietSync,
  runStartedMs,
  researchPhase,
  researchProgress,
  statusText,
  type BlockState,
  type BlockStateInput,
  type LatestRun,
  type Progress,
  type ResearchPhase,
} from "./state"

const HOUR_MS = 60 * 60 * 1000
const LOOKBACK_MS = 12 * HOUR_MS
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

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("")
}

/** A photo when one is stored and loads; initials otherwise. */
function Avatar({
  label,
  photo,
  size = "large",
}: {
  label: string
  photo: string
  size?: "large" | "small"
}) {
  const [failed, setFailed] = React.useState(false)
  return (
    <span className={`avatar avatar-${size}`} title={label}>
      {photo && !failed ? (
        <img
          src={photo}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        initials(label)
      )}
    </span>
  )
}

const openPeek = (id: NotionPageId) =>
  void pages.open(id, { mode: "side_peek" })

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

/** A shimmering placeholder for a line research has not filled in yet. */
function LoadingLine() {
  return (
    <span className="loading-line" aria-label="Researching">
      <span className="skeleton-line skeleton-inline" />
      <span className="loading-label">Researching…</span>
    </span>
  )
}

function PersonCard({
  person,
  phase,
}: {
  person: NotionDataSourcePage
  phase: ResearchPhase
}) {
  const name = text(person.propertiesByKey.Name)
  const email = text(person.propertiesByKey.Email)
  const role = text(person.propertiesByKey.Role)
  const source = hostname(text(person.propertiesByKey["Role source"]))
  const links = profileLinks(person.propertiesByKey)
  return (
    <li className={links.length > 0 ? "person-card has-links" : "person-card"}>
      <button
        type="button"
        className="tile person"
        title="Open person"
        onClick={() => openPeek(person.id)}
      >
        <Avatar
          label={name || email}
          photo={text(person.propertiesByKey.Photo)}
        />
        <span className="tile-body">
          <span className="tile-title">{name || email}</span>
          {(() => {
            const line = cardLine(role, phase)
            if (line.kind === "loading") return <LoadingLine />
            if (line.kind === "none") return null
            return (
              <span className="tile-subtitle">
                {roleLabel(role, text(person.propertiesByKey.Confidence))}
              </span>
            )
          })()}
          {name && <span className="tile-detail">{email}</span>}
          {source && <span className="tile-detail">Role from {source}</span>}
        </span>
      </button>
      {links.length > 0 && (
        <span className="tile-links">
          {links.map((link) => (
            <a
              key={link.label}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {link.label}
            </a>
          ))}
        </span>
      )}
    </li>
  )
}

function CompanyCard({
  domain,
  company,
  attendees,
  phase,
}: {
  domain: string
  company: NotionDataSourcePage | undefined
  attendees: NotionDataSourcePage[]
  phase: ResearchPhase
}) {
  const name = company ? text(company.propertiesByKey.Name) : ""
  const summary = company ? text(company.propertiesByKey.Summary) : ""
  const body = (
    <>
      <span className="logo">{initials(name || domain)}</span>
      <span className="tile-body">
        <span className="tile-title">{name || domain}</span>
        <span className="tile-subtitle">{domain}</span>
        {(() => {
          const line = cardLine(summary, phase)
          if (line.kind === "loading") return <LoadingLine />
          if (line.kind === "none") return null
          return <span className="tile-summary">{summary}</span>
        })()}
        <span className="stack">
          {attendees.map((person) => {
            const label =
              text(person.propertiesByKey.Name) ||
              text(person.propertiesByKey.Email)
            return (
              <Avatar
                key={person.id}
                label={label}
                photo={text(person.propertiesByKey.Photo)}
                size="small"
              />
            )
          })}
          <span className="tile-detail">
            {attendees.length} attendee{attendees.length === 1 ? "" : "s"}
          </span>
        </span>
      </span>
    </>
  )
  return (
    <li>
      {company ? (
        <button
          type="button"
          className="tile company"
          title="Open company"
          onClick={() => openPeek(company.id)}
        >
          {body}
        </button>
      ) : (
        <div className="tile company">{body}</div>
      )}
    </li>
  )
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
              <span className="spinner" aria-hidden="true" />
              {RESEARCHING_LINE}
            </p>
          )}
        </div>
        <div className="actions">
          {status && (
            <span className="pill" data-theme={PILL_THEMES[status] ?? "gray"}>
              Prep {status.toLowerCase()}
            </span>
          )}
          <button
            type="button"
            className="button"
            onClick={() => void pages.open(row.id, { mode: "center_peek" })}
          >
            Open prep
          </button>
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
              <ul className="grid">
                {groups.map((group) => (
                  <CompanyCard
                    key={group.domain}
                    domain={group.domain}
                    company={companies.get(group.domain)}
                    attendees={group.attendees}
                    phase={phase}
                  />
                ))}
              </ul>
            </section>
          )}
          <section>
            <h3 className="section">People</h3>
            <ul className="grid">
              {attendees.map((person) => (
                <PersonCard key={person.id} person={person} phase={phase} />
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
  emptyAction,
}: {
  meetings: readonly NotionDataSourcePage[]
  highlightId: string | null
  now: number
  onSelect: (id: string) => void
  emptyAction: React.ReactNode
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
          {timed.length + allDay.length === 0 && emptyAction}
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
}: {
  view: ViewState
  onChange: (next: ViewState) => void
}) {
  const tab = (mode: Mode, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={view.mode === mode}
      className={`segment${view.mode === mode ? " segment-active" : ""}`}
      onClick={() => onChange({ mode, selectedId: null })}
    >
      {label}
    </button>
  )
  return (
    <nav className="toolbar">
      {view.mode === "day" && view.selectedId ? (
        <button
          type="button"
          className="back"
          aria-label="Back to today"
          title="Back to today"
          onClick={() => onChange({ mode: "day", selectedId: null })}
        >
          <Icon name="back" />
        </button>
      ) : (
        <span />
      )}
      <div className="segments" role="tablist">
        {tab("day", "Today")}
        {tab("next", "Next meeting")}
      </div>
    </nav>
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

const PANEL_TITLES: Record<Exclude<BlockState["kind"], "ready">, string> = {
  never_run: "Be prepared for every external meeting",
  waiting: "Setting up",
  syncing: "Setting up",
  researching: "Setting up",
  failed: "Sync failed",
}

/** First-run, progress, and failure states, with the Sync calendar button. */
function SetupPanel({
  state,
  sync,
}: {
  state: Exclude<BlockState, { kind: "ready" }>
  sync: ReturnType<typeof useSyncRequest>
}) {
  const enabled = canSync(state) && !sync.pending
  const busy =
    state.kind === "waiting" ||
    state.kind === "syncing" ||
    state.kind === "researching"
  return (
    <section className="setup" aria-live="polite">
      <h2 className="title">{PANEL_TITLES[state.kind]}</h2>
      {state.kind === "failed" ? (
        <p className="note" data-theme="red" role="alert">
          <Icon name="alert" />
          <span className="note-text">{state.error}</span>
        </p>
      ) : state.kind === "never_run" ? null : (
        <p className="status-line">
          {busy && !("stale" in state && state.stale) && (
            <span className="spinner" aria-hidden="true" />
          )}
          <span>{statusText(state)}</span>
        </p>
      )}
      {state.kind === "researching" && state.total > 0 && (
        <div
          className="progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={state.total}
          aria-valuenow={state.done}
        >
          <span
            className="progress-bar"
            style={{ width: `${(state.done / state.total) * 100}%` }}
          />
        </div>
      )}
      <div className="setup-actions">
        <button
          type="button"
          className="button button-primary"
          data-theme="blue"
          disabled={!enabled}
          aria-disabled={!enabled}
          onClick={sync.request}
        >
          <Icon name="sync" />
          {sync.pending
            ? "Starting…"
            : state.kind === "failed"
              ? "Retry sync"
              : "Sync calendar"}
        </button>
        {sync.error && (
          <span className="error-text" data-theme="red" role="alert">
            Couldn't start a sync: {sync.error}
          </span>
        )}
      </div>
    </section>
  )
}

/** A secondary "Sync now" button for empty states in the ready UI. */
function SyncNow({
  sync,
  latestRun,
  progress,
  now,
}: {
  sync: ReturnType<typeof useSyncRequest>
  latestRun: LatestRun | null
  progress: Progress
  now: number
}) {
  const { inFlight, status } = quietSync(latestRun, sync.pending, progress, now)
  return (
    <div className="sync-now">
      <button
        type="button"
        className="button"
        disabled={inFlight}
        aria-disabled={inFlight}
        onClick={sync.request}
      >
        <Icon name="sync" />
        Sync now
      </button>
      {status && (
        <span className="status-line" role="status">
          {inFlight && <span className="spinner" aria-hidden="true" />}
          {status}
        </span>
      )}
      {sync.error && !inFlight && (
        <span className="error-text" data-theme="red" role="alert">
          Couldn't start a sync: {sync.error}
        </span>
      )}
    </div>
  )
}

/** Shown once the App is set up but no outside meetings have synced. */
function EmptyState({ action }: { action: React.ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name="calendar" />
      </span>
      <div>
        <div className="empty-title">
          No meetings with outside attendees yet
        </div>
        <p className="muted">
          Meetings sync from your calendar every hour. Meetings with only
          coworkers are hidden.
        </p>
        {action}
      </div>
    </div>
  )
}

type Row = NotionDataSourcePage

/**
 * A live query that reports `loaded` only after its first real result and
 * keeps the previous rows while a changed query reloads (see reduceQuery).
 */
function useLiveQuery(
  key: string,
  options: DataSourceQueryOptions
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
  }, [key, identity])
  return state
}

function MeetingsBlock() {
  const now = useNow()
  const [view, setView] = useViewState()
  const hour = Math.floor(now / HOUR_MS)
  // Reach back to midnight for the day view and 12 hours for long meetings.
  // Round the cutoff to the hour so the subscriptions change once an hour;
  // the previous rows stay on screen while they reload.
  const cutoff = React.useMemo(() => {
    const start = Math.min(dayBounds(now).startMs, now - LOOKBACK_MS)
    return new Date(Math.floor(start / HOUR_MS) * HOUR_MS).toISOString()
  }, [hour])
  const notCancelled = {
    key: "Status",
    select: { does_not_equal: "Cancelled" },
  } as const
  // Date filters compare start dates only, so a multi-day event that began
  // before the cutoff needs its own query: the latest-starting earlier events.
  const upcoming = useLiveQuery("meetings", {
    limit: 50,
    filter: {
      and: [{ key: "When", date: { on_or_after: cutoff } }, notCancelled],
    },
    sorts: [{ key: "When", direction: "ascending" }],
  })
  const earlier = useLiveQuery("meetings", {
    limit: 10,
    filter: { and: [{ key: "When", date: { before: cutoff } }, notCancelled] },
    sorts: [{ key: "When", direction: "descending" }],
  })
  const meetings = sortByStart([...earlier.items, ...upcoming.items])
  const people = useLiveQuery("people", { limit: 999 })
  const companies = useLiveQuery("companies", { limit: 999 })

  // Setup state, derived from existing rows (see state.ts).
  const latestRuns = useLiveQuery("runs", {
    limit: 1,
    sorts: [{ key: "Started", direction: "descending" }],
  })
  const successRuns = useLiveQuery("runs", {
    limit: 2,
    filter: { key: "Status", select: { equals: RUN.success } },
  })
  // Prep updated is written only when a brief is Ready and never cleared.
  const prepped = useLiveQuery("meetings", {
    limit: 1,
    filter: { key: "Prep updated", date: { is_not_empty: true } },
  })
  const finished = useLiveQuery("meetings", {
    limit: 1,
    filter: {
      key: "Prep status",
      select: { equals: [PREP.ready, PREP.failed] },
    },
  })
  const latest = latestRuns.items[0]
  const sync = useSyncRequest(latest?.id ?? null)

  const error =
    upcoming.error ?? earlier.error ?? people.error ?? companies.error
  const runsError = latestRuns.error ?? successRuns.error
  const loaded = [
    upcoming,
    earlier,
    latestRuns,
    successRuns,
    prepped,
    finished,
  ].every((query) => query.loaded)
  const picked = pickMeeting(meetings, now)
  const peopleByEmail = byKey(people.items, "Email")
  const companiesByDomain = byKey(companies.items, "Domain")
  const peopleLoading = !people.loaded

  const input: BlockStateInput | null = loaded
    ? {
        latestRun: latest
          ? {
              id: latest.id,
              status: text(latest.propertiesByKey.Status) || null,
              startedMs: runStartedMs(latest),
              error: text(latest.propertiesByKey.Error),
            }
          : null,
        successRuns: successRuns.items.length,
        hasPrepUpdated: prepped.items.length > 0,
        hasPrepFinished: finished.items.length > 0,
        meetingCount: meetings.length,
        // k and n come from one query: the upcoming meetings.
        progress: researchProgress(upcoming.items, now),
        now,
      }
    : null
  // Either positive signal latches as soon as it loads, before the rest.
  const signal =
    (prepped.loaded && prepped.items.length > 0) ||
    (finished.loaded && finished.items.length > 0)
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

  // Once populated, a query error is a small notice above the last good
  // data, never a replacement for it.
  const notice = error && (
    <div className="note" data-theme="red" role="alert">
      <Icon name="alert" />
      <span className="note-text">Couldn't load meetings: {error.message}</span>
    </div>
  )

  const syncNow = (
    <SyncNow
      sync={sync}
      latestRun={input?.latestRun ?? null}
      progress={researchProgress(upcoming.items, now)}
      now={now}
    />
  )

  let content: React.ReactNode
  if (!populated && error) {
    content = notice
  } else if (!state || (!upcoming.loaded && !earlier.loaded)) {
    // Only before the first result of the session.
    content = <Skeleton />
  } else if (state.kind !== "ready") {
    return (
      <div className="card">
        <SetupPanel state={state} sync={sync} />
      </div>
    )
  } else if (state.noMeetings) {
    content = <EmptyState action={syncNow} />
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
      ) : (
        <DayView
          meetings={meetings}
          highlightId={picked?.row.id ?? null}
          now={now}
          onSelect={(id) => setView({ mode: "day", selectedId: id })}
          emptyAction={syncNow}
        />
      )
  } else if (picked) {
    content = cards(
      picked,
      relative(picked.startMs, picked.endMs, now) || "Next meeting"
    )
  } else {
    content = (
      <div>
        <p className="muted">No upcoming meetings with outside attendees.</p>
        {syncNow}
      </div>
    )
  }

  return (
    <div className="card">
      <Toolbar view={view} onChange={setView} />
      {populated && notice}
      {content}
    </div>
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
