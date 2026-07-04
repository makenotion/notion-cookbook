import { ProviderError } from "./types.js"

export type FetchLike = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>

export interface HttpRequestOptions {
  fetchFn?: FetchLike
  timeoutMs: number
  sleep?: (milliseconds: number) => Promise<void>
  maximumBytes?: number
}

const DEFINITE_MUTATION_REJECTIONS = new Set([
  400, 401, 403, 404, 409, 422, 429,
])

export function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after")
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds))
    return Math.min(300_000, Math.max(0, Math.round(seconds * 1_000)))
  const date = Date.parse(raw)
  if (Number.isNaN(date)) return null
  return Math.min(300_000, Math.max(0, date - Date.now()))
}

export async function boundedText(
  response: Response,
  maximumBytes = 262_144,
  signal?: AbortSignal
): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let output = ""
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
      const pending = reader.read()
      const { done, value } = signal
        ? await new Promise<ReadableStreamReadResult<Uint8Array>>(
            (resolve, reject) => {
              const aborted = (): void => {
                void reader.cancel()
                reject(new DOMException("Aborted", "AbortError"))
              }
              signal.addEventListener("abort", aborted, { once: true })
              void pending.then(
                (chunk) => {
                  signal.removeEventListener("abort", aborted)
                  resolve(chunk)
                },
                (error: unknown) => {
                  signal.removeEventListener("abort", aborted)
                  reject(error)
                }
              )
            }
          )
        : await pending
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel()
        throw new ProviderError(
          "RESPONSE_TOO_LARGE",
          "Provider response exceeded the fixed byte limit.",
          response.status
        )
      }
      output += decoder.decode(value, { stream: true })
    }
    output += decoder.decode()
    return output
  } finally {
    reader.releaseLock()
  }
}

export function isDefiniteMutationRejection(
  error: unknown
): error is ProviderError {
  return (
    error instanceof ProviderError &&
    error.httpStatus !== null &&
    DEFINITE_MUTATION_REJECTIONS.has(error.httpStatus) &&
    (error.code === "AUTHENTICATION_EXPIRED" ||
      error.code === `HTTP_${error.httpStatus}`)
  )
}

function safeProviderMessage(provider: string, status: number): string {
  return `${provider} returned HTTP ${status}; the response body was not exposed.`
}

export async function requestJson<T>(
  provider: "Intercom" | "Jira",
  url: string,
  init: RequestInit,
  options: HttpRequestOptions & {
    mutation: boolean
    expectedStatuses: number[]
  }
): Promise<T> {
  const fetchFn = options.fetchFn ?? fetch
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const attempts = options.mutation ? 1 : 3
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
    let response: Response
    let text: string
    try {
      response = await fetchFn(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      })
      text = await boundedText(
        response,
        options.maximumBytes,
        controller.signal
      )
    } catch (error) {
      clearTimeout(timeout)
      if (!options.mutation && attempt + 1 < attempts) {
        await sleep(50 * 2 ** attempt)
        continue
      }
      throw new ProviderError(
        options.mutation ? "MUTATION_OUTCOME_UNKNOWN" : "PROVIDER_UNAVAILABLE",
        options.mutation
          ? `${provider} mutation response was not observed; reconcile before any retry.`
          : `${provider} could not be reached within the bounded retry policy.`,
        null,
        { retryable: !options.mutation, ambiguous: options.mutation }
      )
    }
    if (options.expectedStatuses.includes(response.status)) {
      if (!text) {
        clearTimeout(timeout)
        return undefined as T
      }
      try {
        const parsed = JSON.parse(text) as T
        clearTimeout(timeout)
        return parsed
      } catch {
        clearTimeout(timeout)
        throw new ProviderError(
          options.mutation
            ? "MUTATION_OUTCOME_UNKNOWN"
            : "INVALID_PROVIDER_RESPONSE",
          options.mutation
            ? `${provider} mutation returned malformed JSON; reconcile before any retry.`
            : `${provider} returned malformed JSON.`,
          response.status,
          options.mutation ? { ambiguous: true } : {}
        )
      }
    }
    clearTimeout(timeout)
    const delay = retryAfterMs(response.headers)
    if (
      !options.mutation &&
      (response.status === 429 || response.status >= 500) &&
      attempt + 1 < attempts
    ) {
      await sleep(Math.min(delay ?? 50 * 2 ** attempt, 5_000))
      continue
    }
    if (
      options.mutation &&
      !DEFINITE_MUTATION_REJECTIONS.has(response.status)
    ) {
      throw new ProviderError(
        "MUTATION_OUTCOME_UNKNOWN",
        safeProviderMessage(provider, response.status),
        response.status,
        {
          ambiguous: true,
        }
      )
    }
    throw new ProviderError(
      response.status === 401
        ? "AUTHENTICATION_EXPIRED"
        : `HTTP_${response.status}`,
      safeProviderMessage(provider, response.status),
      response.status,
      {
        retryable: response.status === 429 || response.status >= 500,
        retryAfterMs: delay,
        status: response.status === 409 ? "conflict" : "blocked",
      }
    )
  }
  throw new ProviderError(
    "PROVIDER_UNAVAILABLE",
    `${provider} exhausted its bounded retry policy.`,
    null,
    {
      retryable: true,
    }
  )
}
