// Development-only UI fixture. This module is excluded from production builds.
import { useState } from "react"
import { createRoot } from "react-dom/client"
import type {
	NotionPagePropertyInputMap,
	NotionPropertySchema,
} from "@notionhq/custom-blocks"
import { Collection } from "./Collection"
import type { Item, Query, View } from "./model"
import type { CollectionSource } from "./source"

type PreviewItem = Omit<Item, "row"> & { id: string }
const themes = [
	"Brand foundations",
	"Customer discovery",
	"Design library",
	"Editorial calendar",
	"Field notes",
	"Launch playbook",
	"Mobile experience",
	"Research archive",
	"Studio website",
	"Team rituals",
	"Usability sessions",
	"Welcome guide",
]
const stages = ["Backlog", "In progress", "Done"]
const fields = ["name", "stage", "summary", "due", "owner", "image", "rating"]
const schemas: { [key: string]: NotionPropertySchema } = {
	name: { name: "Name", type: "title" },
	stage: {
		name: "Stage",
		type: "select",
		options: stages.map((name) => ({ id: name, name })),
	},
	summary: { name: "Summary", type: "rich_text" },
	due: { name: "Due", type: "date" },
	owner: { name: "Owner", type: "people" },
	image: { name: "Image", type: "files" },
	rating: { name: "Rating", type: "number" },
}
const params = new URLSearchParams(location.search)

export function mountPreview(root: HTMLElement, view: View) {
	createRoot(root).render(
		<div
			className="nds"
			data-display-mode={params.get("theme") === "dark" ? "dark" : "light"}
		>
			<div className="preview-banner">
				Simulated preview · in-memory writes · no Notion host or navigation
			</div>
			<Collection view={view} useSource={usePreviewSource} />
		</div>
	)
}

function usePreviewSource(query: Query): CollectionSource {
	const [rows, setRows] = useState<PreviewItem[]>(() =>
		Array.from({ length: 1200 }, (_, i) => ({
			id: `preview-${i + 1}`,
			name: `${themes[i % themes.length]} ${String(i + 1).padStart(4, "0")}`,
			stage: stages[(i + Math.floor(i / themes.length)) % stages.length] ?? "",
			summary: "Make useful things together, with room for thoughtful details.",
			due: `2026-11-${String((i % 28) + 1).padStart(2, "0")}`,
			rating: (i % 5) + 1,
			owners: i % 3 ? ["sample-mira"] : [],
			authors: ["sample-mira"],
			createdAt: "2026-10-23",
		}))
	)
	const matched = rows.filter(
		(row) =>
			row.name
				.toLocaleLowerCase()
				.includes(query.search.trim().toLocaleLowerCase()) &&
			(!query.stage || row.stage === query.stage)
	)
	matched.sort((a, b) => {
		const left = a[query.sort],
			right = b[query.sort]
		if (left === undefined) return right === undefined ? 0 : 1
		if (right === undefined) return -1
		const comparison =
			typeof left === "number" && typeof right === "number"
				? left - right
				: String(left).localeCompare(String(right), "en")
		return query.descending ? -comparison : comparison
	})
	return {
		items:
			params.has("empty") || params.has("loading")
				? []
				: matched.slice(0, query.limit).map((item) => ({
						...item,
						row: {
							id: item.id,
							update: async ({ properties }) => {
								if (params.has("failwrites"))
									return {
										status: "error",
										error: { message: "Simulated read-only database" },
									}
								setRows((current) =>
									current.map((row) =>
										row.id === item.id
											? applyProperties(row, properties ?? {})
											: row
									)
								)
								return { status: "success" }
							},
							open: async () => ({
								status: "error",
								error: {
									message:
										"Simulated preview cannot open a Notion page. Use the host-backed view.",
								},
							}),
						},
					})),
		propertyIdsByKey: Object.fromEntries(
			fields.map((key) => [key, params.has("unbound") ? undefined : key])
		),
		propertySchemasByKey: schemas,
		isLoading: params.has("loading"),
		hasMore: !params.has("empty") && matched.length > query.limit,
		error: params.has("error")
			? { message: "Simulated query failure" }
			: undefined,
		peopleError: undefined,
		owners: new Map([["sample-mira", "Mira"]]),
		create: async (properties) => {
			if (params.has("failwrites"))
				return {
					status: "error",
					error: { message: "Simulated read-only database" },
				}
			const item: PreviewItem = {
				id: crypto.randomUUID(),
				name: "Untitled",
				stage: "",
				summary: "",
				due: "",
				owners: [],
				authors: ["sample-mira"],
				createdAt: "2026-10-23",
				rating: undefined,
			}
			setRows((current) => [...current, applyProperties(item, properties)])
			return { status: "success" }
		},
	}
}

function applyProperties(
	item: PreviewItem,
	properties: NotionPagePropertyInputMap
): PreviewItem {
	const next = { ...item }
	for (const value of Object.values(properties)) {
		if (value.type === "title") next.name = plainText(value.title)
		if (value.type === "rich_text") next.summary = plainText(value.rich_text)
		if (value.type === "select") next.stage = value.select?.name ?? ""
		if (value.type === "status") next.stage = value.status?.name ?? ""
		if (value.type === "number") next.rating = value.number ?? undefined
		if (value.type === "date") next.due = value.date?.start ?? ""
	}
	return next
}

function plainText(values: unknown[]): string {
	return values
		.map((value) => {
			if (!value || typeof value !== "object" || !("text" in value)) return ""
			const text = value.text
			return text &&
				typeof text === "object" &&
				"content" in text &&
				typeof text.content === "string"
				? text.content
				: ""
		})
		.join("")
}
