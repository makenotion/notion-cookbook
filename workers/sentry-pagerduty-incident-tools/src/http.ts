const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_RETRY_AFTER_SECONDS = 60

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

export class ProviderError extends Error {
  readonly provider: string
  readonly status: number | null
  readonly requestId: string | null
  readonly retryable: boolean
  readonly retryAfterSeconds: number | null
  readonly mutationOutcome: "not_attempted" | "not_applied" | "unknown"

  constructor(
    provider: string,
    message: string,
    options: {
      status?: number | null
      requestId?: string | null
      retryable?: boolean
      retryAfterSeconds?: number | null
      mutationOutcome?: "not_attempted" | "not_applied" | "unknown"
    } = {}
  ) {
    super(message)
    this.name = "ProviderError"
    this.provider = provider
    this.status = options.status ?? null
    this.requestId = options.requestId ?? null
    this.retryable = options.retryable ?? false
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
    this.mutationOutcome = options.mutationOutcome ?? "not_attempted"
  }
}

function requestId(response: Response): string | null {
  const value =
    response.headers.get("x-request-id") ??
    response.headers.get("x-pagerduty-request-id")
  return value && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null
}

function retryAfterSeconds(
  value: string | null,
  now: () => Date
): number | null {
  if (!value) return null
  if (/^[0-9]+$/.test(value)) {
    return Math.min(Number(value), MAX_RETRY_AFTER_SECONDS)
  }
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return null
  return Math.min(
    Math.max(0, Math.ceil((timestamp - now().getTime()) / 1_000)),
    MAX_RETRY_AFTER_SECONDS
  )
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The status and headers remain authoritative.
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("empty response")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error("response too large")
    }
    chunks.push(value)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  if (!text) throw new Error("empty response")
  return JSON.parse(text) as unknown
}

class RequestFailure extends Error {}

async function withResponseTimeout<T>(
  fetchImpl: FetchLike,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response: Response
    try {
      response = await fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      })
    } catch {
      throw new RequestFailure("request failed")
    }
    try {
      return await consume(response)
    } catch (error) {
      if (controller.signal.aborted) {
        throw new RequestFailure("request timed out")
      }
      throw error
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function getJson(options: {
  provider: string
  url: URL
  headers: HeadersInit
  fetch: FetchLike
  timeoutMs: number
  attempts?: number
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => Date
}): Promise<{ data: unknown; requestId: string | null }> {
  const attempts = options.attempts ?? 2
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const now = options.now ?? (() => new Date())

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await withResponseTimeout(
        options.fetch,
        options.url,
        { method: "GET", headers: options.headers },
        options.timeoutMs,
        async (response) => {
          const id = requestId(response)
          if (response.ok) {
            try {
              return {
                ok: true as const,
                data: await boundedJson(response),
                requestId: id,
              }
            } catch {
              throw new ProviderError(
                options.provider,
                `${options.provider} returned an invalid or oversized response.`,
                { requestId: id }
              )
            }
          }

          const retryAfter = retryAfterSeconds(
            response.headers.get("retry-after"),
            now
          )
          const retryable = response.status === 429 || response.status >= 500
          await discard(response)
          return {
            ok: false as const,
            status: response.status,
            requestId: id,
            retryable,
            retryAfter,
          }
        }
      )

      if (result.ok) {
        return { data: result.data, requestId: result.requestId }
      }
      if (result.retryable && attempt < attempts) {
        if (result.retryAfter !== null && result.retryAfter > 2) {
          throw new ProviderError(
            options.provider,
            `${options.provider} asked the caller to retry later.`,
            {
              status: result.status,
              requestId: result.requestId,
              retryable: true,
              retryAfterSeconds: result.retryAfter,
            }
          )
        }
        await sleep((result.retryAfter ?? attempt) * 1_000)
        continue
      }
      throw new ProviderError(
        options.provider,
        `${options.provider} returned HTTP ${result.status}.`,
        {
          status: result.status,
          requestId: result.requestId,
          retryable: result.retryable,
          retryAfterSeconds: result.retryAfter,
        }
      )
    } catch (error) {
      if (error instanceof ProviderError) throw error
      if (!(error instanceof RequestFailure)) throw error
      if (attempt < attempts) {
        await sleep(250 * attempt)
        continue
      }
      throw new ProviderError(
        options.provider,
        `${options.provider} could not be read within the retry limit.`,
        { retryable: true }
      )
    }
  }
  throw new Error("unreachable read retry state")
}

export async function postJsonOnce(options: {
  provider: string
  url: URL
  headers: HeadersInit
  body: unknown
  fetch: FetchLike
  timeoutMs: number
  now?: () => Date
}): Promise<{ data: unknown; requestId: string | null }> {
  const now = options.now ?? (() => new Date())
  try {
    return await withResponseTimeout(
      options.fetch,
      options.url,
      {
        method: "POST",
        headers: options.headers,
        body: JSON.stringify(options.body),
      },
      options.timeoutMs,
      async (response) => {
        const id = requestId(response)
        if (response.status !== 201) {
          const retryAfter = retryAfterSeconds(
            response.headers.get("retry-after"),
            now
          )
          const definitelyNotApplied = [400, 401, 402, 403, 404, 429].includes(
            response.status
          )
          await discard(response)
          throw new ProviderError(
            options.provider,
            `${options.provider} returned HTTP ${response.status}.`,
            {
              status: response.status,
              requestId: id,
              retryable: response.status === 429 || response.status >= 500,
              retryAfterSeconds: retryAfter,
              mutationOutcome: definitelyNotApplied ? "not_applied" : "unknown",
            }
          )
        }

        try {
          return { data: await boundedJson(response), requestId: id }
        } catch {
          throw new ProviderError(
            options.provider,
            `${options.provider} accepted the request without a trustworthy response.`,
            { requestId: id, retryable: true, mutationOutcome: "unknown" }
          )
        }
      }
    )
  } catch (error) {
    if (error instanceof ProviderError) throw error
    if (!(error instanceof RequestFailure)) throw error
    throw new ProviderError(
      options.provider,
      `${options.provider} did not return a trustworthy mutation response.`,
      { retryable: true, mutationOutcome: "unknown" }
    )
  }
}
