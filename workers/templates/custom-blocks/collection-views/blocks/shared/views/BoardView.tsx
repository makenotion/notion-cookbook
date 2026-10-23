import { useRef } from "react"
import { DragDropProvider, useDraggable, useDroppable } from "@dnd-kit/react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { Item, Stage } from "../model"
import { Icon } from "../Icons"
import type { ItemActions } from "../Collection"
import {
	DueDate,
	ItemButtons,
	ItemTitle,
	Owners,
	Rating,
	StageChip,
} from "../Properties"

type BoardViewProps = { items: Item[]; stages: Stage[]; actions: ItemActions }

export function BoardView({ items, stages, actions }: BoardViewProps) {
	return (
		<DragDropProvider
			onDragEnd={(event) => {
				if (event.canceled) return
				const { source, target } = event.operation
				const item = items.find((item) => item.row.id === source?.id)
				const stage = stages.find(
					(stage) => `stage:${stage.name}` === target?.id
				)
				if (item && stage) actions.move(item, stage.name)
			}}
		>
			<div
				className="board"
				role="region"
				aria-label="Project board"
				tabIndex={0}
			>
				{[...stages]
					.sort((a, b) =>
						!a.name ? 1 : !b.name ? -1 : a.name.localeCompare(b.name)
					)
					.map((stage) => (
						<BoardColumn
							key={stage.name}
							stage={stage}
							items={items.filter((item) => item.stage === stage.name)}
							actions={actions}
						/>
					))}
			</div>
		</DragDropProvider>
	)
}

type BoardColumnProps = { stage: Stage; items: Item[]; actions: ItemActions }
function BoardColumn({ stage, items, actions }: BoardColumnProps) {
	const { ref, isDropTarget } = useDroppable({
		id: `stage:${stage.name}`,
		disabled: actions.pending,
	})
	const scroll = useRef<HTMLDivElement>(null)
	const virtualizer = useVirtualizer({
		count: items.length,
		getScrollElement: () => scroll.current,
		estimateSize: () => 138,
		getItemKey: (index) => items[index]?.row.id ?? index,
		overscan: 2,
	})
	return (
		<section
			ref={ref}
			className="board-column"
			data-stage={stage.name || "none"}
			data-bg-theme={
				stage.color === "default"
					? "gray"
					: stage.color.replace("_background", "")
			}
			data-over={isDropTarget}
			aria-label={`${stage.name || "No stage"} column`}
		>
			<h2>
				<span>{stage.name ? <StageChip name={stage.name} /> : "No Stage"}</span>
				<span className="muted">{items.length} loaded</span>
			</h2>
			<div
				className="board-scroll"
				data-scroll="board"
				ref={scroll}
				tabIndex={0}
				role="region"
				aria-label={`Scrollable ${stage.name || "No stage"} cards`}
			>
				<div
					className="virtual-content"
					style={{ height: Math.max(virtualizer.getTotalSize(), 60) }}
				>
					{virtualizer.getVirtualItems().map((virtual) => {
						const item = items[virtual.index]
						return (
							item && (
								<div
									className="virtual-row"
									key={virtual.key}
									style={{
										transform: `translateY(${virtual.start}px)`,
										height: 138,
									}}
								>
									<BoardCard item={item} actions={actions} />
								</div>
							)
						)
					})}
					{!items.length && <p className="empty-column">Drop a card here</p>}
				</div>
			</div>
		</section>
	)
}

type BoardCardProps = { item: Item; actions: ItemActions }
function BoardCard({ item, actions }: BoardCardProps) {
	const { ref, handleRef, isDragging } = useDraggable({
		id: item.row.id,
		disabled: actions.pending,
	})
	return (
		<article
			ref={ref}
			className="board-card"
			data-item={item.row.id}
			data-dragging={isDragging}
		>
			<div className="board-card-title">
				<ItemTitle item={item} actions={actions} />
				<ItemButtons item={item} actions={actions} />
				<button
					className="drag-handle"
					ref={handleRef}
					aria-label={`Drag ${item.name}`}
					disabled={actions.pending}
				>
					<Icon name="drag" />
				</button>
			</div>
			<div className="card-properties">
				<StageChip name={item.stage} />
				<DueDate value={item.due} />
				<Owners ids={item.owners} names={actions.owners} />
				<Rating value={item.rating} />
			</div>
		</article>
	)
}
