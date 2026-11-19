// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { Pomodoro } from "../blocks/pomodoro/src/Pomodoro"

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-01-01T12:00:00Z"))
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(() => root.render(<Pomodoro />))
})

afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it("counts down, pauses, resumes, and resets", async () => {
  await click("Start")
  await act(() => vi.advanceTimersByTime(61_000))
  expect(time()).toBe("23:59")
  await click("Pause")
  await act(() => vi.advanceTimersByTime(300_000))
  expect(time()).toBe("23:59")
  await click("Start")
  await act(() => vi.advanceTimersByTime(10_000))
  expect(time()).toBe("23:49")
  await click("Reset")
  expect(time()).toBe("25:00")
})

it("catches up when the document becomes visible after time away", async () => {
  await click("Start")
  vi.setSystemTime(new Date("2026-01-01T12:02:00Z"))
  await act(() => document.dispatchEvent(new Event("visibilitychange")))
  expect(time()).toBe("23:00")
})

it("completes a break and starts the selected duration again", async () => {
  await click("Short break")
  expect(time()).toBe("05:00")
  await click("Start")
  await act(() => vi.advanceTimersByTime(300_000))
  expect(time()).toBe("00:00")
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Session complete"
  )
  await click("Start again")
  expect(time()).toBe("05:00")
  await click("Long break")
  expect(time()).toBe("15:00")
})

function time() {
  return container.querySelector("output")?.textContent
}

async function click(name: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === name
  )
  if (button === undefined) throw new Error(`Missing button: ${name}`)
  await act(() => button.click())
}
