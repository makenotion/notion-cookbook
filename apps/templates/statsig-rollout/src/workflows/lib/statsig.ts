const CONSOLE_API = "https://statsigapi.net/console/v1"

/** Adds IDs to a Statsig ID List segment. Adding an existing ID is a no-op. */
export async function addIdsToSegment(
  apiKey: string,
  segmentId: string,
  ids: string[],
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(
    `${CONSOLE_API}/segments/${encodeURIComponent(segmentId)}/id_list`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "STATSIG-API-KEY": apiKey,
      },
      body: JSON.stringify({ ids }),
      signal,
    }
  )
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new StatsigError(response.status, body.slice(0, 500))
  }
}

export class StatsigError extends Error {
  readonly status: number

  constructor(status: number, body: string) {
    super(`Statsig responded ${status}${body ? `: ${body}` : ""}`)
    this.name = "StatsigError"
    this.status = status
  }

  /** 4xx errors other than conflicts and rate limiting will not succeed on retry. */
  get retryable(): boolean {
    return this.status === 409 || this.status === 429 || this.status >= 500
  }
}
