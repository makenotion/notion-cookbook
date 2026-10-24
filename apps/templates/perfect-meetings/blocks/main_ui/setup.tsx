import React from "react"
import {
  ArrowRight,
  Building2,
  CalendarDays,
  Check,
  CircleAlert,
  Clock3,
  FileText,
  Loader2,
  RefreshCw,
  UsersRound,
} from "lucide-react"

import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import { Card, CardContent, CardFooter, CardHeader } from "./components/ui/card"
import { Progress } from "./components/ui/progress"
import { canSync, statusText, type BlockState } from "./state"
import {
  morningScheduleLabel,
  setupStages,
  type SetupQueries,
} from "./setupState"

const stageIcons = {
  calendar: CalendarDays,
  people: UsersRound,
  companies: Building2,
  meetings: FileText,
}

export function SetupPanel({
  state,
  sync,
  queries,
  now,
}: {
  state: Exclude<BlockState, { kind: "ready" }>
  sync: { pending: boolean; error: string | null; request: () => void }
  queries: SetupQueries
  now: number
}) {
  const firstRun = state.kind === "never_run" && !sync.pending
  const stages = setupStages(state, queries, sync.pending, now)
  const enabled = canSync(state) && !sync.pending
  const warning =
    state.kind === "failed"
      ? state.error
      : ("stale" in state && state.stale) ||
          (state.kind === "researching" && state.stalled > 0)
        ? statusText(state)
        : null
  return (
    <Card
      className="setup-welcome"
      role="region"
      aria-label="First meeting prep"
    >
      <CardHeader className="welcome-header">
        <div className="welcome-topline">
          <span className="welcome-icon" aria-hidden="true">
            <CalendarDays size={23} strokeWidth={1.4} />
          </span>
          <Badge variant="secondary" className="welcome-badge">
            {firstRun
              ? "Let's get you ready"
              : warning
                ? "Needs attention"
                : "Working on it"}
          </Badge>
        </div>
        <h2 className="welcome-title">
          {firstRun
            ? "Walk into every meeting prepared."
            : state.kind === "failed"
              ? "Let's get your sync back on track."
              : "Your meeting prep is taking shape."}
        </h2>
        <p className="welcome-description">
          {firstRun
            ? "Know who you're meeting, what their company does, and what to talk about. All in one brief."
            : "You can leave this page. Your briefs will appear as they're ready."}
        </p>
      </CardHeader>
      <CardContent className="welcome-content">
        {warning && (
          <p className="note" data-theme="orange" role="alert">
            <CircleAlert size={16} className="icon" />
            {warning}
          </p>
        )}
        <div className="welcome-action">
          {firstRun && (
            <p className="welcome-instruction">
              Start by syncing your calendar. We'll take it from here.
            </p>
          )}
          <Button
            type="button"
            className="setup-begin"
            disabled={!enabled}
            onClick={sync.request}
          >
            {sync.pending
              ? "Starting…"
              : firstRun
                ? "Begin Sync"
                : enabled
                  ? "Retry sync"
                  : "Sync in progress"}
            {firstRun ? (
              <ArrowRight size={15} />
            ) : enabled ? (
              <RefreshCw size={15} />
            ) : (
              <Loader2 size={15} className="stage-spinner" />
            )}
          </Button>
          {sync.error && (
            <p className="error-text" data-theme="red" role="alert">
              Couldn't start a sync: {sync.error}
            </p>
          )}
        </div>
        <ol className="setup-stages" aria-live="polite" aria-atomic="true">
          {stages.map((stage) => {
            const StageIcon = stageIcons[stage.key as keyof typeof stageIcons]
            return (
              <li
                className="setup-stage"
                key={stage.key}
                data-status={stage.status}
              >
                <span
                  className="stage-marker"
                  data-theme={
                    stage.status === "complete"
                      ? "green"
                      : stage.status === "attention"
                        ? "orange"
                        : "gray"
                  }
                  aria-hidden="true"
                >
                  {stage.status === "complete" ? (
                    <Check size={16} />
                  ) : stage.status === "attention" ? (
                    <CircleAlert size={16} />
                  ) : (
                    <StageIcon size={16} strokeWidth={1.5} />
                  )}
                </span>
                <div className="stage-body">
                  <div className="stage-heading">
                    <div className="stage-title">{stage.title}</div>
                    {stage.status === "active" && (
                      <Loader2
                        size={13}
                        className="stage-spinner"
                        aria-label="In progress"
                      />
                    )}
                    {stage.status === "complete" && (
                      <Badge
                        variant="secondary"
                        className="stage-badge"
                        data-theme="green"
                      >
                        Done
                      </Badge>
                    )}
                  </div>
                  <p className="meta">{stage.detail}</p>
                  {stage.total !== undefined && stage.total > 0 && (
                    <Progress
                      className="stage-progress"
                      value={((stage.completed ?? 0) / stage.total) * 100}
                      aria-label={stage.title}
                      getValueLabel={() =>
                        `${stage.completed ?? 0} of ${stage.total} complete`
                      }
                    />
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      </CardContent>
      <CardFooter className="welcome-footer">
        <Clock3 size={15} strokeWidth={1.5} aria-hidden="true" />
        <p>
          <strong>Automatic from here.</strong> Calendar syncs every hour.
          <br />
          Today's briefs refresh at {morningScheduleLabel(now)}.
        </p>
      </CardFooter>
    </Card>
  )
}
