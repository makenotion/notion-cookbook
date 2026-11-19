import { useEffect, useState } from "react"

const modes = [
  { id: "focus", label: "Focus", seconds: 25 * 60 },
  { id: "short", label: "Short break", seconds: 5 * 60 },
  { id: "long", label: "Long break", seconds: 15 * 60 },
]

export function Pomodoro() {
  const [mode, setMode] = useState(modes[0])
  const [remaining, setRemaining] = useState(mode.seconds)
  const [deadline, setDeadline] = useState<number>()

  useEffect(() => {
    if (deadline === undefined) {
      return
    }
    const endTime = deadline
    function update() {
      const seconds = Math.max(0, Math.ceil((endTime - Date.now()) / 1000))
      setRemaining(seconds)
      if (seconds === 0) {
        setDeadline(undefined)
      }
    }
    const interval = window.setInterval(update, 250)
    document.addEventListener("visibilitychange", update)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", update)
    }
  }, [deadline])

  function toggle() {
    if (deadline !== undefined) {
      setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)))
      setDeadline(undefined)
      return
    }
    const seconds = remaining === 0 ? mode.seconds : remaining
    setRemaining(seconds)
    setDeadline(Date.now() + seconds * 1000)
  }

  const minutes = Math.floor(remaining / 60)
    .toString()
    .padStart(2, "0")
  const seconds = (remaining % 60).toString().padStart(2, "0")
  let status = "Ready"
  if (remaining === 0) {
    status = "Session complete"
  } else if (deadline !== undefined) {
    status = mode.id === "focus" ? "Focusing" : "On a break"
  } else if (remaining !== mode.seconds) {
    status = "Paused"
  }

  return (
    <main className="timer-shell">
      <section className="timer-card" aria-label="Pomodoro timer">
        <header className="timer-heading">
          <span aria-hidden="true">🍅</span>
          <span>Pomodoro</span>
        </header>
        <div className="timer-main">
          <fieldset className="timer-modes" aria-label="Timer mode">
            {modes.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={mode.id === option.id}
                onClick={() => {
                  setMode(option)
                  setRemaining(option.seconds)
                  setDeadline(undefined)
                }}
              >
                {option.label}
              </button>
            ))}
          </fieldset>
          <div className="timer-dial">
            <svg aria-hidden="true" viewBox="0 0 200 200">
              <circle className="timer-track" cx="100" cy="100" r="94" />
              <circle
                className="timer-progress"
                cx="100"
                cy="100"
                r="94"
                pathLength="100"
                strokeDasharray="100"
                strokeDashoffset={(1 - remaining / mode.seconds) * 100}
              />
            </svg>
            <div className="timer-readout">
              <output
                className="timer-time"
                aria-label="Time remaining"
                aria-live="off"
              >
                {minutes}:{seconds}
              </output>
              <p className="timer-status" role="status">
                {status}
              </p>
            </div>
          </div>
          <div className="timer-actions">
            <button type="button" className="timer-start" onClick={toggle}>
              {deadline !== undefined
                ? "Pause"
                : remaining === 0
                  ? "Start again"
                  : "Start"}
            </button>
            <button
              type="button"
              className="timer-reset"
              onClick={() => {
                setRemaining(mode.seconds)
                setDeadline(undefined)
              }}
            >
              Reset
            </button>
          </div>
        </div>
      </section>
    </main>
  )
}
