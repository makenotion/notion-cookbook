import React from "react"
import { createRoot } from "react-dom/client"
import { pages, type NotionDataSourcePage } from "@notionhq/apps/custom-blocks"
import { NotionCustomBlock, NotionTokenScope, useDataSource } from "@notionhq/apps/react"
import "@notionhq/apps/nds.css"
import "./style.css"

import { firstSentence, pickMeeting, sortByStart, splitEmails, text } from "./meeting"

const LOOKBACK_MS = 12 * 60 * 60 * 1000

/** Current time, refreshed every 30 seconds. */
function useNow(): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

function byKey(rows: readonly NotionDataSourcePage[], key: string): Map<string, NotionDataSourcePage> {
  return new Map(rows.map((row) => [text(row.propertiesByKey[key]).trim().toLowerCase(), row]))
}

function formatWhen(startMs: number, endMs: number, allDay: boolean): string {
  const day = new Date(startMs).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })
  if (allDay) return `${day} · All day`
  const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  return `${day} · ${time(startMs)} – ${time(endMs)}`
}

function relative(startMs: number, endMs: number, now: number): string {
  if (startMs <= now) return now < endMs ? "Happening now" : ""
  const minutes = Math.round((startMs - now) / 60_000)
  if (minutes < 60) return `Starts in ${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `Starts in ${hours} h` : ""
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
function Avatar({ label, photo, onClick }: { label: string; photo: string; onClick: () => void }) {
  const [failed, setFailed] = React.useState(false)
  return (
    <button type="button" className="avatar" title="Open person" onClick={onClick}>
      {photo && !failed ? (
        <img src={photo} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        initials(label)
      )}
    </button>
  )
}

function NextMeeting() {
  const now = useNow()
  // Round the query cutoff so the subscriptions are not replaced on every tick.
  const cutoff = React.useMemo(
    () => new Date(Math.floor((now - LOOKBACK_MS) / 3_600_000) * 3_600_000).toISOString(),
    [Math.floor(now / 3_600_000)],
  )
  const notCancelled = { key: "Status", select: { does_not_equal: "Cancelled" } } as const
  // Date filters compare start dates only, so a multi-day event that began
  // before the cutoff needs its own query: the latest-starting earlier events.
  const upcoming = useDataSource("meetings", {
    limit: 25,
    filter: { and: [{ key: "When", date: { on_or_after: cutoff } }, notCancelled] },
    sorts: [{ key: "When", direction: "ascending" }],
  })
  const earlier = useDataSource("meetings", {
    limit: 10,
    filter: { and: [{ key: "When", date: { before: cutoff } }, notCancelled] },
    sorts: [{ key: "When", direction: "descending" }],
  })
  const meetings = {
    items: sortByStart([...earlier.items, ...upcoming.items]),
    isLoading: upcoming.isLoading || earlier.isLoading,
    error: upcoming.error ?? earlier.error,
  }
  const people = useDataSource("people", { limit: 999 })
  const companies = useDataSource("companies", { limit: 999 })

  const error = meetings.error ?? people.error ?? companies.error
  if (error) return <div className="card muted" role="alert">Couldn't load meetings: {error.message}</div>
  if (meetings.isLoading && meetings.items.length === 0) return <div className="card muted">Loading…</div>

  const picked = pickMeeting(meetings.items, now)
  if (!picked) return <div className="card muted">No upcoming meetings with outside attendees.</div>

  const peopleByEmail = byKey(people.items, "Email")
  const companiesByDomain = byKey(companies.items, "Domain")
  const { row, startMs, endMs, allDay } = picked
  const attendees = splitEmails(text(row.propertiesByKey["Attendee emails"])).flatMap(
    (email) => peopleByEmail.get(email) ?? [],
  )
  const status = text(row.propertiesByKey["Prep status"])
  const soon = relative(startMs, endMs, now)

  return (
    <div className="card">
      <header className="header">
        <div>
          <div className="eyebrow">{soon || "Next meeting"}</div>
          <h2 className="title">{text(row.propertiesByKey.Title) || "Untitled meeting"}</h2>
          <div className="muted">{formatWhen(startMs, endMs, allDay)}</div>
        </div>
        <div className="actions">
          {status && <span className={`pill pill-${status.toLowerCase()}`}>Prep {status.toLowerCase()}</span>}
          <button type="button" className="button" onClick={() => void pages.open(row.id, { mode: "center_peek" })}>
            Open prep
          </button>
        </div>
      </header>

      <ul className="people">
        {attendees.length === 0 && <li className="muted">Attendee details are still loading.</li>}
        {attendees.map((person) => {
          const name = text(person.propertiesByKey.Name)
          const role = text(person.propertiesByKey.Role)
          const email = text(person.propertiesByKey.Email)
          const company = companiesByDomain.get(text(person.propertiesByKey["Company domain"]).toLowerCase())
          const companyName = company ? text(company.propertiesByKey.Name) : ""
          const summary = company ? firstSentence(text(company.propertiesByKey.Summary)) : ""
          return (
            <li key={person.id} className="person">
              <Avatar
                label={name || email}
                photo={text(person.propertiesByKey.Photo)}
                onClick={() => void pages.open(person.id, { mode: "side_peek" })}
              />
              <div className="person-body">
                <div className="person-name">{name || email}</div>
                <div className="person-role">
                  {[role, companyName].filter(Boolean).join(" · ") || email}
                </div>
                {summary && <div className="person-summary">{summary}</div>}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const root = document.getElementById("root")
if (!root) throw new Error("Missing root element")
createRoot(root).render(
  <NotionCustomBlock>
    <NotionTokenScope>
      <NextMeeting />
    </NotionTokenScope>
  </NotionCustomBlock>,
)
