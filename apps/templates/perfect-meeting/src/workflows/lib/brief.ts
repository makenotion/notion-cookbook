export const PREP_HEADING = "## Meeting prep"
export const NOTES_HEADING = "## Notes"

export type Brief = {
  company: string
  role: string
  emails: string
  objective: string
  people: Array<{
    email: string
    name: string
    role: string
    roleSource: string | null
  }>
  companies: Array<{ domain: string; name: string; summary: string }>
}

/** Parse the researcher's JSON reply, tolerating code fences or surrounding prose. */
export function parseBrief(reply: string): Brief {
  const start = reply.indexOf("{")
  const end = reply.lastIndexOf("}")
  if (start === -1 || end <= start)
    throw new Error("Researcher reply did not contain JSON")
  const raw: unknown = JSON.parse(reply.slice(start, end + 1))
  if (typeof raw !== "object" || raw === null)
    throw new Error("Researcher reply was not an object")
  const value = raw as Record<string, unknown>
  const text = (key: string) =>
    typeof value[key] === "string" ? (value[key] as string).trim() : ""
  const list = (key: string) =>
    Array.isArray(value[key]) ? (value[key] as unknown[]) : []
  const brief: Brief = {
    company: text("company"),
    role: text("role"),
    emails: text("emails"),
    objective: text("objective"),
    people: list("people").flatMap((item) => {
      const person = item as Record<string, unknown>
      return typeof person.email === "string" && typeof person.role === "string"
        ? [
            {
              email: person.email.trim().toLowerCase(),
              name: typeof person.name === "string" ? person.name.trim() : "",
              role: person.role.trim(),
              roleSource:
                typeof person.roleSource === "string" &&
                /^https?:\/\//.test(person.roleSource.trim())
                  ? person.roleSource.trim()
                  : null,
            },
          ]
        : []
    }),
    companies: list("companies").flatMap((item) => {
      const company = item as Record<string, unknown>
      return typeof company.domain === "string"
        ? [
            {
              domain: company.domain.trim().toLowerCase(),
              name: typeof company.name === "string" ? company.name.trim() : "",
              summary:
                typeof company.summary === "string"
                  ? company.summary.trim()
                  : "",
            },
          ]
        : []
    }),
  }
  if (!brief.company && !brief.role && !brief.emails && !brief.objective) {
    throw new Error("Researcher reply had no brief sections")
  }
  return brief
}

function paragraph(value: string): string {
  // Keep each section a single paragraph so headings stay intact.
  return value.replace(/\s*\n+\s*/g, " ").trim() || "_No information found._"
}

export function briefMarkdown(brief: Brief, updatedLabel: string): string {
  return [
    PREP_HEADING,
    `_Updated ${updatedLabel}_`,
    "### Company",
    paragraph(brief.company),
    "### Who you're meeting",
    paragraph(brief.role),
    "### Recent email",
    paragraph(brief.emails),
    "### Objective and agenda",
    paragraph(brief.objective),
    "---",
  ].join("\n")
}

export type BodyEdit =
  | { type: "insert"; content: string }
  | { type: "replace"; oldStr: string; newStr: string }

/**
 * Decide how to write a new brief into the page body. An existing prep
 * section (from its heading up to the Notes heading) is replaced; otherwise
 * the brief and a Notes heading are inserted at the top. Anything under Notes
 * is left alone.
 */
export function planBodyEdit(existing: string, brief: string): BodyEdit {
  const prepAt = existing.indexOf(PREP_HEADING)
  if (prepAt !== -1) {
    const notesAt = existing.indexOf(NOTES_HEADING, prepAt)
    if (notesAt !== -1) {
      const oldStr = existing.slice(prepAt, notesAt).trimEnd()
      return { type: "replace", oldStr, newStr: brief }
    }
  }
  return { type: "insert", content: `${brief}\n${NOTES_HEADING}\n` }
}
