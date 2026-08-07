// ──────────────────────────────────────────────────────────────────────
// fetch with a hard timeout
// ──────────────────────────────────────────────────────────────────────
//
// Upstreams stall. EPO OPS in particular throttles dynamically — under load
// it can hold a connection open for minutes rather than fail fast. Without a
// timeout, one stalled request hangs the entire sync indefinitely, with no
// output and no error (a genuinely confusing failure mode). With a timeout it
// fails loudly, so the resilience layer can serve last-known-good (delta) or
// the strict backfill can abort cleanly with the source key in the message.

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  ms = 30_000
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (err) {
    if (ctrl.signal.aborted)
      throw new Error(`request timed out after ${ms}ms: ${url}`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}
