// Small Notion API client. The plugin runs straight from Codex's plugin cache, where
// there is no `npm install`, so it uses `fetch` rather than @notionhq/client.

const NOTION_VERSION = "2025-09-03"
const MAX_RETRIES = 4

export interface PageResponse {
  id: string
  url?: string
  last_edited_time?: string
  in_trash?: boolean
}

export class NotionClient {
  readonly baseUrl: string
  readonly token: string

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl
    this.token = token
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": NOTION_VERSION,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
        continue
      }
      const text = await res.text()
      if (!res.ok)
        throw new Error(
          `${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`
        )
      return (text ? JSON.parse(text) : {}) as T
    }
  }

  getPage(pageId: string): Promise<PageResponse> {
    return this.request("GET", `/v1/pages/${pageId}`)
  }

  trashPage(pageId: string): Promise<PageResponse> {
    return this.request("PATCH", `/v1/pages/${pageId}`, { in_trash: true })
  }
}
