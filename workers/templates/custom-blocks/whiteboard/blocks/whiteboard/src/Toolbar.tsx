import type { BoardItem, ItemColor } from "./model";
import { INK_COLORS, STICKY_COLORS } from "./model";
import {
	ArrowIcon,
	EraserIcon,
	HandIcon,
	LineIcon,
	PenIcon,
	SelectIcon,
	StickyIcon,
} from "./icons";

export type Tool = "select" | "hand" | "pen" | "eraser" | "sticky" | "line" | "arrow";

export const STROKE_WIDTHS = [2, 4, 7] as const;
export const ERASER_RADII = [8, 16, 32] as const;

const TOOLS: Array<{
	id: Tool;
	label: string;
	shortcut: string;
	icon: React.ReactNode;
}> = [
	{ id: "select", label: "Select", shortcut: "V", icon: <SelectIcon /> },
	{ id: "hand", label: "Pan", shortcut: "H", icon: <HandIcon /> },
	{ id: "pen", label: "Pen", shortcut: "P", icon: <PenIcon /> },
	{ id: "eraser", label: "Eraser", shortcut: "E", icon: <EraserIcon /> },
	{ id: "sticky", label: "Sticky note", shortcut: "S", icon: <StickyIcon /> },
	{ id: "line", label: "Line", shortcut: "L", icon: <LineIcon /> },
	{ id: "arrow", label: "Arrow", shortcut: "A", icon: <ArrowIcon /> },
];

export function Toolbar({
	tool,
	onToolChange,
}: {
	tool: Tool;
	onToolChange: (tool: Tool) => void;
}) {
	return (
		<div
			className="wb-toolbar"
			role="toolbar"
			aria-label="Whiteboard tools"
			aria-orientation="horizontal"
		>
			{TOOLS.map((t) => (
				<button
					key={t.id}
					type="button"
					className="wb-tool"
					aria-pressed={tool === t.id}
					aria-label={`${t.label} (${t.shortcut})`}
					aria-keyshortcuts={t.shortcut}
					title={`${t.label} — ${t.shortcut}`}
					onClick={() => onToolChange(t.id)}
				>
					{t.icon}
				</button>
			))}
		</div>
	);
}

const WIDTH_LABELS: Record<number, string> = { 2: "Small", 4: "Medium", 7: "Large" };
const WIDTH_DOT_SIZE: Record<number, number> = { 2: 4, 4: 7, 7: 10 };

const RADIUS_LABELS: Record<number, string> = { 8: "Small", 16: "Medium", 32: "Large" };
const RADIUS_DOT_SIZE: Record<number, number> = { 8: 8, 16: 12, 32: 17 };

export function ToolOptions({
	tool,
	inkColor,
	stickyColor,
	strokeWidth,
	eraserRadius,
	selectedItem,
	onInkColor,
	onStickyColor,
	onStrokeWidth,
	onEraserRadius,
	onSelectedItemChange,
	onEditSelected,
}: {
	tool: Tool;
	inkColor: ItemColor;
	stickyColor: ItemColor;
	strokeWidth: number;
	eraserRadius: number;
	selectedItem: BoardItem | null;
	onInkColor: (c: ItemColor) => void;
	onStickyColor: (c: ItemColor) => void;
	onStrokeWidth: (w: number) => void;
	onEraserRadius: (r: number) => void;
	onSelectedItemChange: (patch: Partial<Omit<BoardItem, "id">>) => void;
	onEditSelected: () => void;
}) {
	if (tool === "hand") return null;

	if (tool === "select") {
		if (!selectedItem) return null;
		if (selectedItem.type === "sticky") {
			return (
				<div
					className="wb-options"
					role="toolbar"
					aria-label="Selected sticky options"
					aria-orientation="horizontal"
				>
					<button
						type="button"
						className="wb-opt wb-opt-label"
						onClick={onEditSelected}
					>
						Edit text
					</button>
					<span className="wb-opt-sep" aria-hidden="true" />
					{STICKY_COLORS.map((c) => (
						<button
							key={c}
							type="button"
							className="wb-opt"
							aria-pressed={selectedItem.color === c}
							aria-label={`Change note to ${c}`}
							title={`${c[0].toUpperCase()}${c.slice(1)} note`}
							onClick={() => onSelectedItemChange({ color: c })}
						>
							<span
								className="wb-swatch-dot"
								style={{ background: `var(--wb-fill-${c})` }}
							/>
						</button>
					))}
				</div>
			);
		}

		return (
			<div
				className="wb-options"
				role="toolbar"
				aria-label="Selected line options"
				aria-orientation="horizontal"
			>
				{INK_COLORS.map((c) => (
					<button
						key={c}
						type="button"
						className="wb-opt"
						aria-pressed={selectedItem.color === c}
						aria-label={`Change line to ${c === "gray" ? "ink" : c}`}
						title={c === "gray" ? "Ink" : `${c[0].toUpperCase()}${c.slice(1)}`}
						onClick={() => onSelectedItemChange({ color: c })}
					>
						<span
							className="wb-swatch-dot"
							style={{ background: `var(--wb-ink-${c})`, borderColor: "transparent" }}
						/>
					</button>
				))}
				<span className="wb-opt-sep" aria-hidden="true" />
				{STROKE_WIDTHS.map((w) => (
					<button
						key={w}
						type="button"
						className="wb-opt"
						aria-pressed={selectedItem.strokeWidth === w}
						aria-label={`Change to ${WIDTH_LABELS[w].toLowerCase()} stroke`}
						title={`${WIDTH_LABELS[w]} stroke`}
						onClick={() => onSelectedItemChange({ strokeWidth: w })}
					>
						<span
							className="wb-width-dot"
							style={{ width: WIDTH_DOT_SIZE[w], height: WIDTH_DOT_SIZE[w] }}
						/>
					</button>
				))}
			</div>
		);
	}

	if (tool === "eraser") {
		return (
			<div
				className="wb-options"
				role="toolbar"
				aria-label="Eraser size"
				aria-orientation="horizontal"
			>
				{ERASER_RADII.map((r) => (
					<button
						key={r}
						type="button"
						className="wb-opt"
						aria-pressed={eraserRadius === r}
						aria-label={`${RADIUS_LABELS[r]} eraser`}
						title={`${RADIUS_LABELS[r]} eraser`}
						onClick={() => onEraserRadius(r)}
					>
						<span
							className="wb-eraser-dot"
							style={{ width: RADIUS_DOT_SIZE[r], height: RADIUS_DOT_SIZE[r] }}
						/>
					</button>
				))}
			</div>
		);
	}

	if (tool === "sticky") {
		return (
			<div
				className="wb-options"
				role="toolbar"
				aria-label="Sticky note color"
				aria-orientation="horizontal"
			>
				{STICKY_COLORS.map((c) => (
					<button
						key={c}
						type="button"
						className="wb-opt"
						aria-pressed={stickyColor === c}
						aria-label={`${c} note`}
						title={`${c[0].toUpperCase()}${c.slice(1)} note`}
						onClick={() => onStickyColor(c)}
					>
						<span
							className="wb-swatch-dot"
							style={{ background: `var(--wb-fill-${c})` }}
						/>
					</button>
				))}
			</div>
		);
	}

	// pen / line / arrow: ink color + stroke width
	return (
		<div
			className="wb-options"
			role="toolbar"
			aria-label="Ink options"
			aria-orientation="horizontal"
		>
			{INK_COLORS.map((c) => (
				<button
					key={c}
					type="button"
					className="wb-opt"
					aria-pressed={inkColor === c}
					aria-label={`${c === "gray" ? "ink" : c} color`}
					title={c === "gray" ? "Ink" : `${c[0].toUpperCase()}${c.slice(1)}`}
					onClick={() => onInkColor(c)}
				>
					<span
						className="wb-swatch-dot"
						style={{ background: `var(--wb-ink-${c})`, borderColor: "transparent" }}
					/>
				</button>
			))}
			<span className="wb-opt-sep" aria-hidden="true" />
			{STROKE_WIDTHS.map((w) => (
				<button
					key={w}
					type="button"
					className="wb-opt"
					aria-pressed={strokeWidth === w}
					aria-label={`${WIDTH_LABELS[w]} stroke`}
					title={`${WIDTH_LABELS[w]} stroke`}
					onClick={() => onStrokeWidth(w)}
				>
					<span
						className="wb-width-dot"
						style={{ width: WIDTH_DOT_SIZE[w], height: WIDTH_DOT_SIZE[w] }}
					/>
				</button>
			))}
		</div>
	);
}
