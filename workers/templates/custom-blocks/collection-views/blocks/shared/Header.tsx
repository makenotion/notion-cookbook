import { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import type { OpenPageMode } from "@notionhq/custom-blocks"
import type { Query, View } from "./model"
import { Icon } from "./Icons"

export type ColumnKey = "name" | "stage" | "due" | "owner" | "rating"
export type Column = {
	key: ColumnKey
	label: string
	width: number
	visible: boolean
}
export const DEFAULT_COLUMNS: Column[] = [
	{ key: "name", label: "Name", width: 300, visible: true },
	{ key: "stage", label: "Stage", width: 150, visible: true },
	{ key: "due", label: "Due", width: 150, visible: true },
	{ key: "owner", label: "Owner", width: 170, visible: true },
	{ key: "rating", label: "Rating", width: 100, visible: true },
]
type HeaderProps = {
	view: View
	query: Query
	stages: string[]
	mode: OpenPageMode
	previewImages: boolean
	onPreviewImages: (value: boolean) => void
	columns: Column[]
	pending: boolean
	bound: boolean
	onQuery: (patch: Partial<Query>) => void
	onMode: (mode: OpenPageMode) => void
	onColumns: (columns: Column[]) => void
	onCreate: () => void
}

export function Header({
	view,
	query,
	stages,
	mode,
	columns,
	previewImages,
	onPreviewImages,
	pending,
	bound,
	onQuery,
	onMode,
	onColumns,
	onCreate,
}: HeaderProps) {
	const [searching, setSearching] = useState(false)
	const search = useRef<HTMLInputElement>(null)
	useEffect(() => {
		if (searching) search.current?.focus()
	}, [searching])
	return (
		<header className="collection-header">
			<h1 className="database-title">Projects</h1>
			<div className="view-bar">
				<span className="view-tab" aria-current="page">
					<Icon name={view} />
					{view[0].toUpperCase() + view.slice(1)}
				</span>
				<div className="view-controls">
					<ControlPopover
						label="Filter"
						icon="filter"
						active={Boolean(query.stage)}
					>
						<h2>Filter</h2>
						<label>
							Stage
							<select
								aria-label="Filter stage"
								value={query.stage}
								onChange={(event) => onQuery({ stage: event.target.value })}
							>
								<option value="">All stages</option>
								{stages.filter(Boolean).map((stage) => (
									<option key={stage}>{stage}</option>
								))}
							</select>
						</label>
					</ControlPopover>
					<ControlPopover
						label="Sort"
						icon="sort"
						active={query.sort !== "name" || query.descending}
					>
						<h2>Sort</h2>
						<label>
							Property
							<select
								aria-label="Sort property"
								value={query.sort}
								onChange={(event) => {
									const value = event.target.value
									if (value === "name" || value === "due" || value === "rating")
										onQuery({ sort: value })
								}}
							>
								<option value="name">Name</option>
								<option value="due">Due</option>
								<option value="rating">Rating</option>
							</select>
						</label>
						<button
							aria-label={
								query.descending ? "Sort ascending" : "Sort descending"
							}
							onClick={() => onQuery({ descending: !query.descending })}
						>
							<Icon name="sort" />
							{query.descending ? "Descending" : "Ascending"}
						</button>
					</ControlPopover>
					{searching || query.search ? (
						<div className="search-control">
							<Icon name="search" />
							<input
								ref={search}
								type="search"
								aria-label="Search projects"
								placeholder="Search…"
								value={query.search}
								onChange={(event) => onQuery({ search: event.target.value })}
								onKeyDown={(event) => {
									if (event.key === "Escape") {
										onQuery({ search: "" })
										setSearching(false)
									}
								}}
							/>
						</div>
					) : (
						<button
							className="icon-button"
							aria-label="Search projects"
							title="Search"
							onClick={() => setSearching(true)}
						>
							<Icon name="search" />
						</button>
					)}
					<ControlPopover label="View options" icon="properties">
						<h2>View options</h2>
						<label>
							Open pages in
							<select
								aria-label="Open pages in"
								value={mode}
								onChange={(event) =>
									onMode(
										event.target.value === "center_peek"
											? "center_peek"
											: "side_peek"
									)
								}
							>
								<option value="side_peek">Side peek</option>
								<option value="center_peek">Center peek</option>
							</select>
						</label>
						{view === "gallery" && (
							<label>
								Card preview
								<select
									aria-label="Card preview"
									value={previewImages ? "image" : "none"}
									onChange={(event) =>
										onPreviewImages(event.target.value === "image")
									}
								>
									<option value="none">None</option>
									<option value="image">Image</option>
								</select>
							</label>
						)}
						{view === "table" && (
							<fieldset>
								<legend>Properties</legend>
								{columns.map((column) => (
									<label className="check-label" key={column.key}>
										<Icon name={column.key} />
										<span>{column.label}</span>
										<input
											type="checkbox"
											checked={column.visible}
											disabled={column.key === "name"}
											onChange={(event) =>
												onColumns(
													columns.map((current) =>
														current.key === column.key
															? { ...current, visible: event.target.checked }
															: current
													)
												)
											}
										/>
									</label>
								))}
							</fieldset>
						)}
					</ControlPopover>
					<button
						className="new-button"
						disabled={pending || !bound}
						onClick={onCreate}
						aria-label="New project"
					>
						New
					</button>
				</div>
			</div>
		</header>
	)
}

type PopoverProps = {
	label: string
	icon: "filter" | "sort" | "properties"
	active?: boolean
	children: ReactNode
}
function ControlPopover({
	label,
	icon,
	active = false,
	children,
}: PopoverProps) {
	const ref = useRef<HTMLDetailsElement>(null)
	useEffect(() => {
		function close(event: PointerEvent) {
			if (
				event.target instanceof Node &&
				!ref.current?.contains(event.target) &&
				ref.current
			)
				ref.current.open = false
		}
		document.addEventListener("pointerdown", close)
		return () => document.removeEventListener("pointerdown", close)
	}, [])
	return (
		<details
			ref={ref}
			className="control-popover"
			onKeyDown={(event) => {
				if (event.key === "Escape" && ref.current) {
					ref.current.open = false
					ref.current.querySelector("summary")?.focus()
				}
			}}
		>
			<summary
				aria-label={label}
				title={label}
				className="icon-button"
				data-active={active}
			>
				<Icon name={icon} />
			</summary>
			<div className="popover-panel">{children}</div>
		</details>
	)
}
