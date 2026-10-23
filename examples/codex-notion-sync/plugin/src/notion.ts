// Small Notion Public API client. The plugin runs straight from Codex's plugin cache, where
// there is no `npm install`, so it uses `fetch` rather than @notionhq/client.

const NOTION_VERSION = "2025-09-03"
const MAX_RETRIES = 4
const MAX_BLOCKS_PER_REQUEST = 100

export interface PageResponse {
  id: string
  url?: string
  last_edited_time?: string
  in_trash?: boolean
}

export interface DatabaseResponse {
  id: string
  data_sources?: { id: string }[]
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
      const isForm = body instanceof FormData
      const res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": NOTION_VERSION,
          ...(isForm || body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        body:
          body === undefined ? undefined : isForm ? body : JSON.stringify(body),
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

  // Direct upload: create a file upload, then send the bytes (files up to 20 MB).
  async uploadFile(
    filename: string,
    contentType: string,
    data: string
  ): Promise<string> {
    const upload = await this.request<{ id: string }>(
      "POST",
      "/v1/file_uploads",
      {
        filename,
        content_type: contentType,
      }
    )
    const form = new FormData()
    form.append("file", new Blob([data], { type: contentType }), filename)
    await this.request("POST", `/v1/file_uploads/${upload.id}/send`, form)
    return upload.id
  }

  async appendChildren(blockId: string, children: unknown[]): Promise<void> {
    for (const batch of batchBlocks(children))
      await this.request("PATCH", `/v1/blocks/${blockId}/children`, {
        children: batch,
      })
  }

  getPage(pageId: string): Promise<PageResponse> {
    return this.request("GET", `/v1/pages/${pageId}`)
  }

  trashPage(pageId: string): Promise<PageResponse> {
    return this.request("PATCH", `/v1/pages/${pageId}`, { in_trash: true })
  }
}

// A request may carry at most 100 blocks, nested children included.
export function batchBlocks(blocks: unknown[]): unknown[][] {
  const batches: unknown[][] = []
  let current: unknown[] = []
  let size = 0
  for (const block of blocks) {
    const n = countBlocks(block)
    if (current.length && size + n > MAX_BLOCKS_PER_REQUEST) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(block)
    size += n
  }
  if (current.length) batches.push(current)
  return batches
}

function countBlocks(block: unknown): number {
  if (!block || typeof block !== "object") return 1
  let n = 1
  for (const value of Object.values(block)) {
    if (
      value &&
      typeof value === "object" &&
      "children" in value &&
      Array.isArray(value.children)
    )
      for (const child of value.children) n += countBlocks(child)
  }
  return n
}
