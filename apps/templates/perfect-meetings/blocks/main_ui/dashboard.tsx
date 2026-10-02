import React from "react"
import {
  ArrowRight,
  Building2,
  CalendarCheck2,
  CalendarDays,
  Check,
  CircleAlert,
  Clock3,
  Loader2,
  RefreshCw,
  UsersRound,
} from "lucide-react"
import type { NotionDataSourcePage } from "@notionhq/apps/custom-blocks"

import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import { Progress } from "./components/ui/progress"
import { researchActivity } from "./derive"
import type { CalendarStatus } from "./dashboardState"
import type { QueryState } from "./live"
import { morningScheduleLabel } from "./setupState"

export function SyncAction({
  status,
  onSync,
  primary = false,
}: {
  status: CalendarStatus
  onSync: () => void
  primary?: boolean
}) {
  return (
    <Button
      variant={primary ? "default" : "outline"}
      size={primary ? "default" : "sm"}
      className="dashboard-sync"
      disabled={
        status.busy ||
        status.kind === "loading" ||
        status.kind === "unavailable"
      }
      onClick={onSync}
    >
      {status.busy ? (
        <Loader2 className="stage-spinner" aria-hidden="true" />
      ) : (
        <RefreshCw aria-hidden="true" />
      )}
      {status.kind === "waiting"
        ? "Starting…"
        : status.kind === "syncing"
          ? "Syncing…"
          : status.kind === "failed" || status.kind === "stale"
            ? "Retry sync"
            : "Sync now"}
    </Button>
  )
}

export function EmptyMeetings({
  status,
  onSync,
  scope = "upcoming",
  onNext,
}: {
  status: CalendarStatus
  onSync: () => void
  scope?: "today" | "upcoming"
  onNext?: () => void
}) {
  const needsAttention = status.kind === "failed" || status.kind === "stale"
  const checked = status.kind === "success"
  return (
    <section className="dashboard-empty" aria-label="Meeting prep">
      <div className="empty-topline">
        <span className="dashboard-empty-icon" aria-hidden="true">
          {checked ? (
            <CalendarCheck2 size={24} strokeWidth={1.4} />
          ) : (
            <CalendarDays size={24} strokeWidth={1.4} />
          )}
        </span>
        <Badge variant="secondary" className="empty-badge">
          {status.busy
            ? "Checking your calendar"
            : needsAttention
              ? "Needs attention"
              : checked
                ? "Calendar checked"
                : "Meeting prep"}
        </Badge>
      </div>
      <h2>
        {status.busy
          ? "Finding your next meeting."
          : needsAttention
            ? "Let's get your calendar back in sync."
            : checked
              ? scope === "today"
                ? "A little breathing room today."
                : "No outside meetings coming up."
              : "Your next meeting prep starts here."}
      </h2>
      <p className="empty-description">
        {status.busy
          ? "We're checking for meetings and outside attendees. Your briefs will appear here as they're ready."
          : needsAttention
            ? "We couldn't finish your last calendar check. Try syncing again to bring your meetings up to date."
            : checked && scope === "today"
              ? "No meetings with outside attendees today. Your briefs will be here when you need them."
              : "Meetings with people outside your organization appear here, along with research to help you prepare."}
      </p>
      <div className="empty-actions">
        {onNext && !status.busy && !needsAttention ? (
          <>
            <Button className="dashboard-sync" onClick={onNext}>
              View next meeting <ArrowRight aria-hidden="true" />
            </Button>
            <SyncAction status={status} onSync={onSync} />
          </>
        ) : (
          <SyncAction status={status} onSync={onSync} primary />
        )}
        <span className="empty-hint">
          {status.busy
            ? "You can leave this page. We'll keep working."
            : "New event? Bring it in now."}
        </span>
      </div>
    </section>
  )
}

function ResearchRow({
  label,
  query,
  now,
}: {
  label: "People" | "Companies"
  query: QueryState<NotionDataSourcePage>
  now: number
}) {
  const counts = researchActivity(query.items, now)
  const Icon = label === "People" ? UsersRound : Building2
  const parts = [
    { value: counts.researching, label: "researching", kind: "active" },
    { value: counts.queued, label: "queued", kind: "quiet" },
    { value: counts.done, label: "complete", kind: "quiet" },
    { value: counts.failed, label: "failed", kind: "attention" },
    { value: counts.stalled, label: "may be stuck", kind: "attention" },
    { value: counts.unrequested, label: "not queued", kind: "quiet" },
  ].filter((part) => part.value > 0)
  return (
    <div className="research-row" role="group" aria-label={`${label} research`}>
      <div className="research-row-heading">
        <span className="research-row-label">
          <Icon size={15} strokeWidth={1.6} aria-hidden="true" />
          {label}
          {query.hasData && (
            <span className="research-total">
              {counts.total.toLocaleString()}
              {query.hasMore ? "+" : ""}
            </span>
          )}
        </span>
        {!query.hasData ? (
          <span className="research-detail">
            {query.error ? "Status unavailable" : "Loading…"}
          </span>
        ) : (
          <div className="research-row-counts">
            {parts.length === 0 ? (
              <span className="research-detail">None yet</span>
            ) : (
              parts.map((part) => (
                <span
                  key={part.label}
                  className="research-count"
                  data-kind={part.kind}
                  data-theme={part.kind === "attention" ? "orange" : "gray"}
                >
                  {part.kind === "active" && !query.error && (
                    <Loader2
                      size={12}
                      className="stage-spinner"
                      aria-hidden="true"
                    />
                  )}
                  {part.value.toLocaleString()} {part.label}
                </span>
              ))
            )}
          </div>
        )}
      </div>
      {query.hasData &&
        counts.total > 0 &&
        counts.researching > 0 &&
        !query.error && (
          <Progress
            className="research-row-progress"
            value={(counts.done / counts.total) * 100}
            aria-label={`${label} research complete`}
            getValueLabel={() => `${counts.done} of ${counts.total} complete`}
          />
        )}
      {query.error && query.hasData && (
        <p className="research-detail">
          Couldn't refresh. Showing last known counts.
        </p>
      )}
      {query.hasMore && (
        <p className="research-detail">
          Counts cover the first {counts.total.toLocaleString()} records.
        </p>
      )}
    </div>
  )
}

export function ActivitySummary({
  people,
  companies,
  status,
  now,
}: {
  people: QueryState<NotionDataSourcePage>
  companies: QueryState<NotionDataSourcePage>
  status: CalendarStatus
  now: number
}) {
  const empty = [people, companies].every(
    (query) =>
      query.hasData &&
      !query.error &&
      !query.hasMore &&
      query.items.length === 0
  )
  const attention = ["failed", "stale", "unavailable"].includes(status.kind)
  const StatusIcon = status.busy
    ? Loader2
    : attention
      ? CircleAlert
      : status.kind === "success"
        ? Check
        : Clock3
  return (
    <footer className="dashboard-activity">
      {!empty && (
        <section className="research-summary" aria-label="Research status">
          <h3>Research</h3>
          <ResearchRow label="People" query={people} now={now} />
          <ResearchRow label="Companies" query={companies} now={now} />
        </section>
      )}
      <div
        className="calendar-health"
        data-theme={attention ? "orange" : "gray"}
      >
        <span role="status">
          <StatusIcon
            size={14}
            className={status.busy ? "stage-spinner" : undefined}
            aria-hidden="true"
          />
          {status.label}
        </span>
        <span className="sync-frequency">Checks every hour</span>
      </div>
      {status.detail && (
        <p className="sync-detail" data-theme="orange">
          {status.detail}
        </p>
      )}
      {empty && (
        <p className="research-empty">
          <UsersRound size={14} strokeWidth={1.5} aria-hidden="true" />
          People and company research will appear with your meetings.
        </p>
      )}
      <p className="refresh-schedule">
        Today's briefs refresh at {morningScheduleLabel(now)}.
      </p>
    </footer>
  )
}
