import type {
  NotionPropertySchema,
  NotionPropertyType,
} from "@notionhq/custom-blocks"
import type { WhiteboardSetupIssue } from "./model"

type PropertyRequirement = {
  key: string
  label: string
  type: NotionPropertyType
  options?: readonly string[]
}

export const WHITEBOARD_SCHEMA_REQUIREMENTS: readonly PropertyRequirement[] = [
  { key: "title", label: "Title", type: "title" },
  {
    key: "type",
    label: "Type",
    type: "select",
    options: ["sticky", "stroke", "line", "arrow"],
  },
  {
    key: "color",
    label: "Color",
    type: "select",
    options: ["yellow", "blue", "pink", "green", "purple", "red", "gray"],
  },
  { key: "x", label: "X", type: "number" },
  { key: "y", label: "Y", type: "number" },
  { key: "width", label: "Width", type: "number" },
  { key: "height", label: "Height", type: "number" },
  { key: "points", label: "Points", type: "rich_text" },
  { key: "strokeWidth", label: "Stroke width", type: "number" },
  { key: "z", label: "Z", type: "number" },
]

export const WHITEBOARD_SCHEMA_GUIDE = [
  { label: "Title", detail: "Title property" },
  {
    label: "Type",
    detail: "Select · sticky, stroke, line, arrow",
  },
  {
    label: "Color",
    detail: "Select · yellow, blue, pink, green, purple, red, gray",
  },
  {
    label: "Position and size",
    detail: "X, Y, Width, Height, Stroke width, and Z · Number",
  },
  { label: "Points", detail: "Rich text property" },
] as const

function typeLabel(type: NotionPropertyType): string {
  return type === "rich_text"
    ? "Rich text"
    : `${type.charAt(0).toUpperCase()}${type.slice(1)}`
}

export function validateWhiteboardSchema(
  schemasByKey: Record<string, NotionPropertySchema | undefined>
): WhiteboardSetupIssue[] {
  const issues: WhiteboardSetupIssue[] = []

  for (const requirement of WHITEBOARD_SCHEMA_REQUIREMENTS) {
    const schema = schemasByKey[requirement.key]
    if (!schema) {
      issues.push({
        property: requirement.label,
        message: `Map this field to a ${typeLabel(requirement.type)} property.`,
      })
      continue
    }

    if (schema.type !== requirement.type) {
      issues.push({
        property: requirement.label,
        message: `Map this field to a ${typeLabel(requirement.type)} property instead of ${typeLabel(schema.type)}.`,
      })
      continue
    }

    if (requirement.options && schema.type === "select") {
      const available = new Set(schema.options.map((option) => option.name))
      const missing = requirement.options.filter(
        (option) => !available.has(option)
      )
      if (missing.length > 0) {
        issues.push({
          property: requirement.label,
          message: `Add the missing Select ${missing.length === 1 ? "option" : "options"}: ${missing.join(", ")}.`,
        })
      }
    }
  }

  return issues
}
