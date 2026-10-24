import { asPage, prop, read, type Notion } from "../../lib/props.js"
import { RESEARCH_STATUS } from "../../notion.js"

/** Only a populated, never-queued profile is handed to the agent automatically. */
export function needsResearch(properties: Record<string, unknown>): boolean {
  if (read.select(properties, "Research status")) return false
  // Preserve records researched before the Ready handoff existed.
  return (
    !read.date(properties, "Researched at") &&
    !read.text(properties, "Role").trim() &&
    !read.select(properties, "Confidence") &&
    !read.text(properties, "Summary").trim()
  )
}

/** Re-read on retries: never reset an agent's in-flight or completed work. */
export async function readyForResearch(
  notion: Notion,
  pageId: string
): Promise<void> {
  const page = asPage(await notion.pages.retrieve({ page_id: pageId }))
  if (!needsResearch(page.properties)) return
  if (
    !read.email(page.properties, "Email") &&
    !read.text(page.properties, "Domain").trim()
  )
    return
  await notion.pages.update({
    page_id: pageId,
    properties: { "Research status": prop.select(RESEARCH_STATUS.ready) },
  })
}
