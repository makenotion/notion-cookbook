import { useEffect, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { Item, View } from "../model"
import type { ItemActions } from "../Collection"
import type { Column } from "../Header"
import { Icon } from "../Icons"
import {
	Cover,
	DueDate,
	ItemButtons,
	ItemMeta,
	ItemTitle,
	Owners,
	PageBodyPlaceholder,
	Rating,
	RelativeDate,
	StageChip,
} from "../Properties"

type VirtualRowsProps = {
	items: Item[]
	view: Exclude<View, "board">
	actions: ItemActions
	previewImages: boolean
	columns: Column[]
	onColumns: (columns: Column[]) => void
}
export function VirtualRows({
	items,
	view,
	actions,
	columns,
	previewImages,
	onColumns,
}: VirtualRowsProps) {
	const scroll = useRef<HTMLDivElement>(null)
	const [width, setWidth] = useState(800)
	const resizing = useRef<
		{ index: number; x: number; width: number } | undefined
	>(undefined)
	useEffect(() => {
		const element = scroll.current
		if (!element) return
		const observer = new ResizeObserver(([entry]) => {
			if (entry) setWidth(entry.contentRect.width)
		})
		observer.observe(element)
		return () => observer.disconnect()
	}, [])
	const gridColumns =
		view === "gallery" ? Math.max(1, Math.floor((width + 16) / 276)) : 1
	const covers = view === "gallery" && previewImages
	const height =
		view === "table"
			? 37
			: view === "list"
				? 32
				: view === "gallery"
					? covers
						? 294
						: 146
					: 254
	const visible = columns.filter((column) => column.visible)
	const tableStyle = {
		gridTemplateColumns: `${visible.map((column) => `${column.width}px`).join(" ")} minmax(32px, 1fr)`,
		minWidth: visible.reduce((sum, column) => sum + column.width, 32),
	}
	const virtualizer = useVirtualizer({
		count: Math.ceil(items.length / gridColumns),
		getScrollElement: () => scroll.current,
		estimateSize: () => height,
		getItemKey: (index) => items[index * gridColumns]?.row.id ?? index,
		overscan: 3,
	})
	return (
		<section
			className={`view ${view}-view`}
			role={view === "table" ? "table" : undefined}
			tabIndex={view === "table" ? 0 : undefined}
			aria-rowcount={view === "table" ? items.length + 1 : undefined}
			aria-label={`${view} projects`}
		>
			{view === "table" && (
				<div
					className="table-head table-grid"
					role="row"
					aria-rowindex={1}
					style={tableStyle}
				>
					{visible.map((column) => (
						<div key={column.key} role="columnheader">
							<Icon name={column.key} />
							<span>{column.label}</span>
							<span
								className="column-resizer"
								role="separator"
								tabIndex={0}
								aria-label={`Resize ${column.label}`}
								aria-orientation="vertical"
								aria-valuenow={column.width}
								aria-valuemin={80}
								aria-valuemax={800}
								onKeyDown={(event) => {
									if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
										event.preventDefault()
										onColumns(
											columns.map((current) =>
												current.key === column.key
													? {
															...current,
															width: Math.max(
																80,
																Math.min(
																	800,
																	column.width +
																		(event.key === "ArrowRight" ? 10 : -10)
																)
															),
														}
													: current
											)
										)
									}
								}}
								onPointerDown={(event) => {
									event.currentTarget.setPointerCapture(event.pointerId)
									resizing.current = {
										index: columns.indexOf(column),
										x: event.clientX,
										width: column.width,
									}
								}}
								onPointerMove={(event) => {
									const drag = resizing.current
									if (drag)
										onColumns(
											columns.map((current, index) =>
												index === drag.index
													? {
															...current,
															width: Math.max(
																80,
																Math.min(
																	800,
																	drag.width + event.clientX - drag.x
																)
															),
														}
													: current
											)
										)
								}}
								onPointerUp={() => {
									resizing.current = undefined
								}}
								onLostPointerCapture={() => {
									resizing.current = undefined
								}}
							/>
						</div>
					))}
					<div role="columnheader" />
				</div>
			)}
			<div
				ref={scroll}
				className="virtual-scroll"
				style={
					view === "table"
						? { minWidth: tableStyle.minWidth, overflowX: "hidden" }
						: undefined
				}
				data-scroll={view}
				tabIndex={0}
				role={view === "table" ? "rowgroup" : "region"}
				aria-label={`Scrollable ${view} projects`}
			>
				<div
					className="virtual-content"
					style={{
						height: virtualizer.getTotalSize(),
						minWidth: view === "table" ? tableStyle.minWidth : undefined,
					}}
				>
					{virtualizer.getVirtualItems().map((virtual) => (
						<div
							className="virtual-row"
							key={virtual.key}
							style={{
								transform: `translateY(${virtual.start}px)`,
								height,
								display: "grid",
								gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
								gap: view === "gallery" ? 16 : 0,
							}}
						>
							{items
								.slice(
									virtual.index * gridColumns,
									(virtual.index + 1) * gridColumns
								)
								.map((item, offset) => (
									<CollectionItem
										key={item.row.id}
										index={virtual.index * gridColumns + offset}
										item={item}
										actions={actions}
										view={view}
										previewImages={previewImages}
										columns={visible}
										tableStyle={tableStyle}
									/>
								))}
						</div>
					))}
				</div>
			</div>
		</section>
	)
}

type CollectionItemProps = {
	item: Item
	actions: ItemActions
	view: Exclude<View, "board">
	index: number
	previewImages: boolean
	columns: Column[]
	tableStyle: { gridTemplateColumns: string; minWidth: number }
}
function CollectionItem({
	item,
	actions,
	view,
	index,
	previewImages,
	columns,
	tableStyle,
}: CollectionItemProps) {
	if (view === "table")
		return (
			<div
				className="table-grid table-row"
				role="row"
				aria-rowindex={index + 2}
				data-item={item.row.id}
				style={tableStyle}
			>
				{columns.map((column) => (
					<div
						role="cell"
						key={column.key}
						data-property={column.key}
						onDoubleClick={() => actions.edit(item)}
					>
						{column.key === "name" ? (
							<>
								<ItemTitle item={item} actions={actions} />
								<ItemButtons item={item} actions={actions} />
							</>
						) : column.key === "stage" ? (
							<StageChip name={item.stage} colors={actions.stageColors} />
						) : column.key === "due" ? (
							<DueDate value={item.due} />
						) : column.key === "owner" ? (
							<Owners ids={item.owners} names={actions.owners} />
						) : (
							<Rating value={item.rating} />
						)}
					</div>
				))}
				<div role="cell" />
			</div>
		)
	if (view === "list")
		return (
			<article className="list-row" data-item={item.row.id}>
				<ItemTitle item={item} actions={actions} />
				<ItemMeta item={item} actions={actions} />
				<ItemButtons item={item} actions={actions} />
			</article>
		)
	if (view === "gallery")
		return (
			<article className="gallery-card" data-item={item.row.id}>
				{previewImages && <Cover item={item} />}
				<div className="card-content">
					<ItemTitle item={item} actions={actions} />
					<ItemButtons item={item} actions={actions} />
					<div className="card-properties">
						<StageChip name={item.stage} colors={actions.stageColors} />
						<DueDate value={item.due} />
						<Owners ids={item.owners} names={actions.owners} />
						<Rating value={item.rating} />
					</div>
				</div>
			</article>
		)
	return (
		<article className="feed-card" data-item={item.row.id}>
			<div className="feed-byline">
				<span className="author-avatar" aria-hidden="true" />
				<span>
					{item.authors
						.map((id) => actions.owners.get(id) ?? `Person ${id.slice(0, 8)}`)
						.join(", ") || "Unknown author"}
				</span>
				<span className="muted">
					<RelativeDate value={item.createdAt} />
				</span>
			</div>
			<div className="feed-content">
				<ItemTitle item={item} actions={actions} />
				<ItemMeta item={item} actions={actions} />
				<PageBodyPlaceholder />
				<button
					className="feed-open"
					onClick={() => actions.open(item)}
					disabled={actions.pending}
				>
					<Icon name="open" size={14} />
					Open page
				</button>
			</div>
			<ItemButtons item={item} actions={actions} />
		</article>
	)
}
