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
  if (!Number.isSafeInteger(ms) || ms <= 0)
    throw new Error(`request timeout must be a positive integer: ${ms}`)
  // AbortSignal.timeout remains attached after headers arrive, so a stalled
  // response body is bounded too. Clearing a manual timer immediately after
  // fetch() resolves would protect only the header phase.
  const timeoutSignal = AbortSignal.timeout(ms)
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal
  try {
    return await fetch(url, { ...init, signal })
  } catch (err) {
    if (timeoutSignal.aborted)
      throw new Error(`request timed out after ${ms}ms: ${url}`)
    throw err
  }
}
