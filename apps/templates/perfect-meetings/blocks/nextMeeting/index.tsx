import React from "react"
import { createRoot } from "react-dom/client"
import {
  pages,
  type NotionDataSourcePage,
  type NotionPageId,
} from "@notionhq/apps/custom-blocks"
import {
  NotionCustomBlock,
  NotionTokenScope,
  useDataSource,
} from "@notionhq/apps/react"
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
    return { mode: "next", selectedId: null }
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

function PersonCard({ person }: { person: NotionDataSourcePage }) {
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
          <span className="tile-subtitle">
            {roleLabel(role, text(person.propertiesByKey.Confidence))}
          </span>
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
}: {
  domain: string
  company: NotionDataSourcePage | undefined
  attendees: NotionDataSourcePage[]
}) {
  const name = company ? text(company.propertiesByKey.Name) : ""
  const summary = company ? text(company.propertiesByKey.Summary) : ""
  const body = (
    <>
      <span className="logo">{initials(name || domain)}</span>
      <span className="tile-body">
        <span className="tile-title">{name || domain}</span>
        <span className="tile-subtitle">{domain}</span>
        <span className="tile-summary">{summary || "Research pending."}</span>
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
}: {
  meeting: Picked
  eyebrow: string
  people: Map<string, NotionDataSourcePage>
  companies: Map<string, NotionDataSourcePage>
}) {
  const { row, startMs, endMs, allDay } = meeting
  const attendees = splitEmails(
    text(row.propertiesByKey["Attendee emails"])
  ).flatMap((email) => people.get(email) ?? [])
  const groups = groupByCompany(attendees, (person) =>
    text(person.propertiesByKey["Company domain"])
  )
  const status = text(row.propertiesByKey["Prep status"])

  return (
    <>
      <header className="header">
        <div>
          <div className="eyebrow">{eyebrow}</div>
          <h2 className="title">
            {text(row.propertiesByKey.Title) || "Untitled meeting"}
          </h2>
          <div className="muted">{formatWhen(startMs, endMs, allDay)}</div>
        </div>
        <div className="actions">
          {status && (
            <span className={`pill pill-${status.toLowerCase()}`}>
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

      {attendees.length === 0 ? (
        <p className="muted">Attendee details are still loading.</p>
      ) : (
        <>
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
                  />
                ))}
              </ul>
            </section>
          )}
          <section>
            <h3 className="section">People</h3>
            <ul className="grid">
              {attendees.map((person) => (
                <PersonCard key={person.id} person={person} />
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
          <div className="eyebrow">Today</div>
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
          <div className="events">
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
              <div className="now" style={{ top: px(now) }} />
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
          ←
        </button>
      ) : (
        <span />
      )}
      <div className="segments" role="tablist">
        {tab("next", "Next meeting")}
        {tab("day", "Today")}
      </div>
    </nav>
  )
}

function MeetingsBlock() {
  const now = useNow()
  const [view, setView] = useViewState()
  const hour = Math.floor(now / HOUR_MS)
  // Reach back to midnight for the day view and 12 hours for long meetings.
  // Round the cutoff so the subscriptions are not replaced on every tick.
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
  const upcoming = useDataSource("meetings", {
    limit: 50,
    filter: {
      and: [{ key: "When", date: { on_or_after: cutoff } }, notCancelled],
    },
    sorts: [{ key: "When", direction: "ascending" }],
  })
  const earlier = useDataSource("meetings", {
    limit: 10,
    filter: { and: [{ key: "When", date: { before: cutoff } }, notCancelled] },
    sorts: [{ key: "When", direction: "descending" }],
  })
  const meetings = sortByStart([...earlier.items, ...upcoming.items])
  const people = useDataSource("people", { limit: 999 })
  const companies = useDataSource("companies", { limit: 999 })

  const error =
    upcoming.error ?? earlier.error ?? people.error ?? companies.error
  const loading =
    (upcoming.isLoading || earlier.isLoading) && meetings.length === 0
  const picked = pickMeeting(meetings, now)
  const peopleByEmail = byKey(people.items, "Email")
  const companiesByDomain = byKey(companies.items, "Domain")

  let content: React.ReactNode
  if (error) {
    content = (
      <div className="muted" role="alert">
        Couldn't load meetings: {error.message}
      </div>
    )
  } else if (loading) {
    content = <div className="muted">Loading…</div>
  } else if (view.mode === "day") {
    const selected = view.selectedId
      ? meetings.find((row) => row.id === view.selectedId)
      : undefined
    const range = selected && dateRange(selected.propertiesByKey.When)
    content =
      selected && range ? (
        <MeetingCards
          meeting={{ row: selected, ...range }}
          eyebrow={
            selected.id === picked?.row.id
              ? relative(range.startMs, range.endMs, now) || "Next meeting"
              : "Meeting"
          }
          people={peopleByEmail}
          companies={companiesByDomain}
        />
      ) : (
        <DayView
          meetings={meetings}
          highlightId={picked?.row.id ?? null}
          now={now}
          onSelect={(id) => setView({ mode: "day", selectedId: id })}
        />
      )
  } else if (picked) {
    content = (
      <MeetingCards
        meeting={picked}
        eyebrow={relative(picked.startMs, picked.endMs, now) || "Next meeting"}
        people={peopleByEmail}
        companies={companiesByDomain}
      />
    )
  } else {
    content = (
      <div className="muted">No upcoming meetings with outside attendees.</div>
    )
  }

  return (
    <div className="card">
      <Toolbar view={view} onChange={setView} />
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
