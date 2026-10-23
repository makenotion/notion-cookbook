import { useEffect, useRef, useState } from "react"
import type {
	NotionPagePropertyInputMap,
	OpenPageMode,
} from "@notionhq/custom-blocks"
import { performAction } from "./actions"
import type { ActionResult } from "./actions"
import { MAX_ROWS, nextLimit, stagesFor, stageProperty } from "./model"
import type { Item, Query, View } from "./model"
import { BoardView } from "./views/BoardView"
import { VirtualRows } from "./views/VirtualRows"
import { DEFAULT_COLUMNS, Header } from "./Header"
import { Editor } from "./Editor"
import type { CollectionSourceHook } from "./source"

export type ItemActions = {
	open: (item: Item) => void
	edit: (item: Item) => void
	move: (item: Item, stage: string) => void
	pending: boolean
	owners: ReadonlyMap<string, string>
	stages: string[]
}
type CollectionProps = { view: View; useSource: CollectionSourceHook }

export function Collection({ view, useSource }: CollectionProps) {
	const [query, setQuery] = useState<Query>({
		search: "",
		stage: "",
		sort: view === "feed" ? "due" : "name",
		descending: view === "feed",
		limit: 100,
	})
	const [stageType, setStageType] = useState<"select" | "status">("select")
	const source = useSource(query, stageType, view === "feed")
	const [columns, setColumns] = useState(DEFAULT_COLUMNS)
	const [previewImages, setPreviewImages] = useState(false)
	const [mode, setMode] = useState<OpenPageMode>("side_peek")
	const [error, setError] = useState<string>()
	const [notice, setNotice] = useState("")
	const [pending, setPending] = useState(false)
	const writeLock = useRef(false)
	const [editing, setEditing] = useState<
		{ kind: "create" } | { kind: "edit"; item: Item }
	>()
	const items = source.items
	const schema = source.propertySchemasByKey
	const stages = stagesFor(schema.stage, items)

	useEffect(() => {
		if (schema.stage?.type === "status" || schema.stage?.type === "select")
			setStageType(schema.stage.type)
	}, [schema.stage])

	async function run(
		action: () => Promise<ActionResult>,
		success: string
	): Promise<boolean> {
		if (writeLock.current) return false
		writeLock.current = true
		setPending(true)
		setError(undefined)
		setNotice("")
		const failure = await performAction(action)
		writeLock.current = false
		setPending(false)
		if (failure !== undefined) {
			setError(failure)
			return false
		}
		setNotice(success)
		return true
	}

	function move(item: Item, stage: string) {
		if (stage === item.stage) return
		void run(
			() => item.row.update({ properties: stageProperty(stage, stageType) }),
			`Moved “${item.name}” to ${stage || "No stage"}.`
		)
	}
	const actions: ItemActions = {
		open: (item) => {
			void run(() => item.row.open(mode), "")
		},
		edit: (item) => setEditing({ kind: "edit", item }),
		move,
		pending,
		owners: source.owners,
		stages: stages.map((stage) => stage.name),
	}

	async function save(
		properties: NotionPagePropertyInputMap
	): Promise<boolean> {
		if (!editing) return false
		return run(
			() =>
				editing.kind === "edit"
					? editing.item.row.update({ properties })
					: source.create(properties),
			editing.kind === "edit"
				? "Saved project."
				: "Created project. It may be outside the current filter or loaded window."
		)
	}
	function changeQuery(patch: Partial<Query>) {
		setQuery((current) => ({ ...current, ...patch, limit: 100 }))
	}
	const bound = Boolean(source.propertyIdsByKey.name)
	return (
		<main className="collection">
			<Header
				view={view}
				query={query}
				stages={stages.map((stage) => stage.name)}
				mode={mode}
				columns={columns}
				previewImages={previewImages}
				onPreviewImages={setPreviewImages}
				pending={pending}
				bound={bound}
				onQuery={changeQuery}
				onMode={setMode}
				onColumns={setColumns}
				onCreate={() => setEditing({ kind: "create" })}
			/>
			<div className="status-line" role="status">
				{pending
					? "Saving…"
					: source.isLoading
						? "Updating…"
						: notice ||
							(source.peopleError
								? `People names unavailable: ${source.peopleError}`
								: "")}
			</div>
			{error !== undefined && (
				<div className="error" role="alert">
					Request failed: {error}{" "}
					<button onClick={() => setError(undefined)}>Dismiss</button>
				</div>
			)}
			{source.error ? (
				<div className="empty" role="alert">
					<h2>Couldn’t load projects</h2>
					<p>{source.error.message}</p>
					<button onClick={() => location.reload()}>Retry connection</button>
				</div>
			) : source.isLoading && !items.length ? (
				<div className="empty" role="status">
					Loading projects…
				</div>
			) : !bound ? (
				<div className="empty">
					<h2>Connect Projects</h2>
					<p>Bind a database and map Name in the host’s Data settings.</p>
				</div>
			) : !items.length ? (
				<div className="empty">
					<h2>No projects here yet</h2>
					<p>Try another filter or create a project.</p>
				</div>
			) : view === "board" ? (
				<BoardView items={items} stages={stages} actions={actions} />
			) : (
				<VirtualRows
					items={items}
					view={view}
					previewImages={previewImages}
					actions={actions}
					columns={columns}
					onColumns={setColumns}
				/>
			)}
			<footer>
				<span className="loaded-count">
					{items.length} loaded{source.hasMore ? " · more available" : ""}
				</span>
				<span>
					{view === "board"
						? "Column counts show loaded cards. Moves change Stage; order follows the selected sort."
						: "Showing database properties. Open a page for its full content."}
				</span>
				{source.hasMore && query.limit < MAX_ROWS && (
					<button
						disabled={source.isLoading}
						onClick={() =>
							setQuery((current) => ({
								...current,
								limit: nextLimit(current.limit),
							}))
						}
					>
						Load more
					</button>
				)}
				{source.hasMore && query.limit >= MAX_ROWS && (
					<strong>
						999-row SDK limit reached. Narrow the search or Stage filter to see
						other matches.
					</strong>
				)}
			</footer>
			{editing && (
				<Editor
					key={editing.kind === "edit" ? editing.item.row.id : "new"}
					item={editing.kind === "edit" ? editing.item : undefined}
					stages={stages}
					stageType={stageType}
					mapped={source.propertyIdsByKey}
					pending={pending}
					error={error}
					onSave={save}
					onClose={() => setEditing(undefined)}
				/>
			)}
		</main>
	)
}
