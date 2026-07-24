import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	CSSProperties,
	PointerEvent as ReactPointerEvent,
	ReactNode,
} from "react";
import type {
	BoardItem,
	ItemColor,
	Point,
	WhiteboardSetupIssue,
	WhiteboardStore,
} from "./model";
import { autoLabel } from "./model";
import {
	arrowHead,
	boundingBox,
	circleHitsPolyline,
	samplePolyline,
	smoothPath,
	snapTo45,
	stickyRotation,
} from "./geometry";
import { Toolbar, ToolOptions } from "./Toolbar";
import type { Tool } from "./Toolbar";

const STICKY_SIZE = 160;
const VIEWPORT_HEIGHT = 480;
const WORLD_WIDTH = 2400;
const WORLD_HEIGHT = 1600;
const ERASE_FADE_MS = 130;

type Draft =
	| { kind: "pen"; points: Point[] }
	| { kind: "line" | "arrow"; start: Point; end: Point };

type Drag = { id: string; offsetX: number; offsetY: number };
type PanDrag = { start: Point; origin: Point };

const TOOL_KEYS: Record<string, Tool> = {
	v: "select",
	h: "hand",
	p: "pen",
	e: "eraser",
	s: "sticky",
	l: "line",
	a: "arrow",
};

function clamp(n: number, min: number, max: number): number {
	return Math.min(Math.max(n, min), Math.max(min, max));
}

function clampPan([x, y]: Point, viewportWidth: number): Point {
	return [
		clamp(x, Math.min(0, viewportWidth - WORLD_WIDTH), 0),
		clamp(y, VIEWPORT_HEIGHT - WORLD_HEIGHT, 0),
	];
}

function inkVar(color: ItemColor): string {
	return `var(--wb-ink-${color})`;
}

function stickyFont(len: number): { fontSize: string; lineHeight: string } {
	if (len <= 48) {
		return {
			fontSize: "var(--text-body)",
			lineHeight: "var(--text-body--line-height)",
		};
	}
	if (len <= 140) {
		return {
			fontSize: "var(--text-body-sm)",
			lineHeight: "var(--text-body-sm--line-height)",
		};
	}
	return {
		fontSize: "var(--text-body-xs)",
		lineHeight: "var(--text-body-xs--line-height)",
	};
}

function prefersReducedMotion(): boolean {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function WhiteboardSetup({
	title,
	body,
	issues = [],
}: {
	title: string;
	body: ReactNode;
	issues?: WhiteboardSetupIssue[];
}) {
	return (
		<div className="wb-setup" role="alert">
			<div className="wb-setup-inner">
				<p className="wb-setup-title">{title}</p>
				<p className="wb-setup-body">{body}</p>
				{issues.length > 0 && (
					<ul className="wb-setup-list">
						{issues.map((issue) => (
							<li className="wb-setup-item" key={issue.property}>
								<strong>{issue.property}</strong>
								<span>{issue.message}</span>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

export function Whiteboard({ store }: { store: WhiteboardStore }) {
	const { items, isLoading, loadError, setupIssues, saveState } = store;

	const [tool, setToolState] = useState<Tool>("select");
	const [inkColor, setInkColor] = useState<ItemColor>("gray");
	const [stickyColor, setStickyColor] = useState<ItemColor>("yellow");
	const [strokeWidth, setStrokeWidth] = useState<number>(4);
	const [eraserRadius, setEraserRadius] = useState<number>(16);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [drag, setDrag] = useState<Drag | null>(null);
	const [pan, setPan] = useState<Point>([0, 0]);
	const [panDrag, setPanDrag] = useState<PanDrag | null>(null);
	const [spacePressed, setSpacePressed] = useState(false);
	const [eraserPos, setEraserPos] = useState<Point | null>(null);
	const [dyingIds, setDyingIds] = useState<ReadonlySet<string>>(new Set());

	const rootRef = useRef<HTMLDivElement>(null);
	const erasing = useRef(false);
	const dyingRef = useRef(new Set<string>());

	const maxZ = useMemo(
		() => items.reduce((max, it) => Math.max(max, it.z), 0),
		[items],
	);
	const sorted = useMemo(
		() => [...items].sort((a, b) => a.z - b.z || a.id.localeCompare(b.id)),
		[items],
	);
	const selectedItem = useMemo(
		() => items.find((item) => item.id === selectedId) ?? null,
		[items, selectedId],
	);

	useEffect(() => {
		if (selectedId && !selectedItem) {
			setSelectedId(null);
			setEditingId(null);
		}
	}, [selectedId, selectedItem]);

	const setTool = useCallback((next: Tool) => {
		setToolState(next);
		setDraft(null);
		setDrag(null);
		if (next !== "select") {
			setSelectedId(null);
			setEditingId(null);
		}
	}, []);

	const toScreen = useCallback((e: ReactPointerEvent): Point => {
		const rect = rootRef.current?.getBoundingClientRect();
		if (!rect) return [0, 0];
		return [e.clientX - rect.left, e.clientY - rect.top];
	}, []);

	const toLocal = useCallback(
		(e: ReactPointerEvent): Point => {
			const [x, y] = toScreen(e);
			return [x - pan[0], y - pan[1]];
		},
		[toScreen, pan],
	);

	/** Keep every item inside the finite whiteboard. */
	const clampPos = useCallback((item: BoardItem, x: number, y: number): Point => {
		return [
			clamp(x, 0, WORLD_WIDTH - item.width),
			clamp(y, 0, WORLD_HEIGHT - item.height),
		];
	}, []);

	const kill = useCallback(
		(id: string) => {
			if (dyingRef.current.has(id)) return;
			if (prefersReducedMotion()) {
				store.deleteItem(id);
				return;
			}
			dyingRef.current.add(id);
			setDyingIds(new Set(dyingRef.current));
			setTimeout(() => {
				dyingRef.current.delete(id);
				setDyingIds(new Set(dyingRef.current));
				store.deleteItem(id);
			}, ERASE_FADE_MS);
		},
		[store],
	);

	const eraseStrokesAt = useCallback(
		(p: Point) => {
			for (const it of items) {
				if (it.type === "sticky" || dyingRef.current.has(it.id)) continue;
				const abs = it.points.map(
					([px, py]) => [px + it.x, py + it.y] as Point,
				);
				if (circleHitsPolyline(p, eraserRadius + it.strokeWidth / 2 + 1, abs)) {
					kill(it.id);
				}
			}
		},
		[items, eraserRadius, kill],
	);

	const stickyAt = useCallback(
		(p: Point): BoardItem | undefined =>
			[...items]
				.filter((it) => it.type === "sticky" && !dyingRef.current.has(it.id))
				.sort((a, b) => b.z - a.z)
				.find(
					(it) =>
						p[0] >= it.x &&
						p[0] <= it.x + it.width &&
						p[1] >= it.y &&
						p[1] <= it.y + it.height,
				),
		[items],
	);

	const commitEdit = useCallback(
		(id: string, text: string) => {
			const item = items.find((candidate) => candidate.id === id);
			if (item && item.title !== text) {
				store.updateItem(id, { title: text });
			}
			setEditingId(null);
		},
		[items, store],
	);

	// ---------- Canvas pointer handlers ----------

	const onCanvasPointerDown = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			if ((e.button !== 0 && e.button !== 1) || isLoading) return;
			if (e.target instanceof HTMLTextAreaElement) return;
			// Let the floating toolbar / options handle their own clicks.
			// capturing the pointer here would swallow their click events.
			if ((e.target as Element).closest?.(".wb-toolbar, .wb-options")) return;
			e.preventDefault();
			rootRef.current?.focus({ preventScroll: true });
			rootRef.current?.setPointerCapture(e.pointerId);
			const screen = toScreen(e);

			if (tool === "hand" || spacePressed || e.button === 1) {
				setPanDrag({ start: screen, origin: pan });
				setDraft(null);
				setDrag(null);
				return;
			}

			// Suppress the compat mousedown's focus default so a freshly
			// mounted sticky textarea keeps focus.
			const p = toLocal(e);

			switch (tool) {
				case "select":
					setSelectedId(null);
					setEditingId(null);
					break;
				case "pen":
					setDraft({ kind: "pen", points: [p] });
					break;
				case "line":
				case "arrow":
					setDraft({ kind: tool, start: p, end: p });
					break;
				case "sticky": {
					const existing = stickyAt(p);
					if (existing) {
						setSelectedId(existing.id);
						break;
					}
					const x = Math.round(
						clamp(
							p[0] - STICKY_SIZE / 2,
							8,
							WORLD_WIDTH - STICKY_SIZE - 8,
						),
					);
					const y = Math.round(
						clamp(
							p[1] - STICKY_SIZE / 2,
							8,
							WORLD_HEIGHT - STICKY_SIZE - 8,
						),
					);
					const id = store.createItem({
						type: "sticky",
						title: "",
						color: stickyColor,
						x,
						y,
						width: STICKY_SIZE,
						height: STICKY_SIZE,
						points: [],
						strokeWidth: 2,
						z: maxZ + 1,
					});
					// Drop straight into typing, and return to Select so the next
					// click doesn't plant an accidental second note.
					setToolState("select");
					setSelectedId(id);
					setEditingId(id);
					break;
				}
				case "eraser": {
					erasing.current = true;
					setEraserPos(p);
					eraseStrokesAt(p);
					const sticky = stickyAt(p);
					if (sticky) kill(sticky.id);
					break;
				}
			}
		},
		[
			tool,
			isLoading,
			spacePressed,
			toScreen,
			pan,
			toLocal,
			stickyAt,
			store,
			stickyColor,
			maxZ,
			eraseStrokesAt,
			kill,
		],
	);

	const onCanvasPointerMove = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			if (panDrag) {
				const screen = toScreen(e);
				setPan(
					clampPan(
						[
							panDrag.origin[0] + screen[0] - panDrag.start[0],
							panDrag.origin[1] + screen[1] - panDrag.start[1],
						],
						rootRef.current?.clientWidth ?? 600,
					),
				);
				return;
			}
			const p = toLocal(e);
			if (tool === "eraser") {
				setEraserPos(p);
				if (erasing.current) eraseStrokesAt(p);
			}
			if (draft) {
				if (draft.kind === "pen") {
					setDraft((prev) => {
						if (!prev || prev.kind !== "pen") return prev;
						const last = prev.points[prev.points.length - 1];
						const dx = p[0] - last[0];
						const dy = p[1] - last[1];
						if (dx * dx + dy * dy < 4) return prev;
						return { kind: "pen", points: [...prev.points, p] };
					});
				} else {
					const shift = e.shiftKey;
					setDraft((prev) => {
						if (!prev || prev.kind === "pen") return prev;
						let end = p;
						if (shift) {
							const [sx, sy] = snapTo45(
								p[0] - prev.start[0],
								p[1] - prev.start[1],
							);
							end = [prev.start[0] + sx, prev.start[1] + sy];
						}
						return { ...prev, end };
					});
				}
			}
			if (drag) {
				const item = items.find((it) => it.id === drag.id);
				if (item) {
					const [x, y] = clampPos(item, p[0] - drag.offsetX, p[1] - drag.offsetY);
					store.updateItem(drag.id, { x, y });
				}
			}
		},
		[
			panDrag,
			toScreen,
			tool,
			toLocal,
			eraseStrokesAt,
			draft,
			drag,
			store,
			items,
			clampPos,
		],
	);

	const finalizeDraft = useCallback(() => {
		if (!draft) return;
		if (draft.kind === "pen") {
			if (draft.points.length === 0) {
				setDraft(null);
				return;
			}
			const pts = samplePolyline(draft.points, 2);
			const box = boundingBox(pts);
			store.createItem({
				type: "stroke",
				title: autoLabel("stroke"),
				color: inkColor,
				x: Math.round(box.x),
				y: Math.round(box.y),
				width: Math.round(box.width),
				height: Math.round(box.height),
				points: pts.map(([x, y]) => [x - box.x, y - box.y] as Point),
				strokeWidth,
				z: maxZ + 1,
			});
		} else {
			const { start, end } = draft;
			if (Math.hypot(end[0] - start[0], end[1] - start[1]) >= 4) {
				const box = boundingBox([start, end]);
				store.createItem({
					type: draft.kind,
					title: autoLabel(draft.kind),
					color: inkColor,
					x: Math.round(box.x),
					y: Math.round(box.y),
					width: Math.round(box.width),
					height: Math.round(box.height),
					points: [
						[start[0] - box.x, start[1] - box.y],
						[end[0] - box.x, end[1] - box.y],
					],
					strokeWidth,
					z: maxZ + 1,
				});
			}
		}
		setDraft(null);
	}, [draft, store, inkColor, strokeWidth, maxZ]);

	const onCanvasPointerUp = useCallback(() => {
		erasing.current = false;
		if (panDrag) {
			setPanDrag(null);
			return;
		}
		if (drag) setDrag(null);
		if (draft) finalizeDraft();
	}, [panDrag, drag, draft, finalizeDraft]);

	const onCanvasPointerCancel = useCallback(() => {
		erasing.current = false;
		setPanDrag(null);
		setDrag(null);
		setDraft(null);
	}, []);

	const onCanvasPointerLeave = useCallback(() => {
		setEraserPos(null);
	}, []);

	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;

		const handleWheel = (e: WheelEvent) => {
			if (e.ctrlKey) return;
			e.preventDefault();
			e.stopPropagation();
			const scale =
				e.deltaMode === WheelEvent.DOM_DELTA_LINE
					? 18
					: e.deltaMode === WheelEvent.DOM_DELTA_PAGE
						? VIEWPORT_HEIGHT
						: 1;
			setPan(([x, y]) =>
				clampPan(
					[x - e.deltaX * scale, y - e.deltaY * scale],
					root.clientWidth,
				),
			);
		};

		const resizeObserver = new ResizeObserver(() => {
			setPan((current) => clampPan(current, root.clientWidth));
		});
		resizeObserver.observe(root);
		root.addEventListener("wheel", handleWheel, { passive: false });
		return () => {
			resizeObserver.disconnect();
			root.removeEventListener("wheel", handleWheel);
		};
	}, []);

	useEffect(() => {
		const handleKeyUp = (event: KeyboardEvent) => {
			if (event.code === "Space") setSpacePressed(false);
		};
		const handleBlur = () => setSpacePressed(false);
		window.addEventListener("keyup", handleKeyUp);
		window.addEventListener("blur", handleBlur);
		return () => {
			window.removeEventListener("keyup", handleKeyUp);
			window.removeEventListener("blur", handleBlur);
		};
	}, []);

	/** Fallback: double-click edits the sticky under the pointer even when the
	 *  sticky tool is active (item pointer events are off outside Select). */
	const onCanvasDoubleClick = useCallback(
		(e: React.MouseEvent<HTMLDivElement>) => {
			if (tool !== "sticky") return;
			const rect = rootRef.current?.getBoundingClientRect();
			if (!rect) return;
			const hit = stickyAt([
				e.clientX - rect.left - pan[0],
				e.clientY - rect.top - pan[1],
			]);
			if (hit) {
				setToolState("select");
				setSelectedId(hit.id);
				setEditingId(hit.id);
			}
		},
		[tool, stickyAt, pan],
	);

	// ---------- Item pointer handlers (select tool) ----------

	const onItemPointerDown = useCallback(
		(e: ReactPointerEvent, item: BoardItem) => {
			if (spacePressed || e.button === 1) return;
			if (tool !== "select" || e.button !== 0) return;
			e.stopPropagation();
			rootRef.current?.focus({ preventScroll: true });
			rootRef.current?.setPointerCapture(e.pointerId);
			setSelectedId(item.id);
			if (editingId === item.id) return;
			if (editingId) setEditingId(null);
			const p = toLocal(e);
			setDrag({ id: item.id, offsetX: p[0] - item.x, offsetY: p[1] - item.y });
		},
		[spacePressed, tool, editingId, toLocal],
	);

	const onStickyDoubleClick = useCallback(
		(e: ReactPointerEvent | React.MouseEvent, item: BoardItem) => {
			if (tool !== "select") return;
			e.stopPropagation();
			setDrag(null);
			setSelectedId(item.id);
			setEditingId(item.id);
		},
		[tool],
	);

	// ---------- Keyboard ----------

	const onKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			if (e.target instanceof HTMLTextAreaElement) return;
			const key = e.key.toLowerCase();

			if (e.code === "Space") {
				e.preventDefault();
				setSpacePressed(true);
				return;
			}
			if (key === "escape") {
				setTool("select");
				setSelectedId(null);
				setDraft(null);
				setPanDrag(null);
				return;
			}
			if (key === "delete" || key === "backspace") {
				if (selectedId) {
					e.preventDefault();
					kill(selectedId);
					setSelectedId(null);
				}
				return;
			}
			if (key === "enter") {
				const item = items.find((it) => it.id === selectedId);
				if (item?.type === "sticky") {
					e.preventDefault();
					setEditingId(item.id);
				}
				return;
			}
			if (key.startsWith("arrow") && selectedId) {
				const item = items.find((it) => it.id === selectedId);
				if (!item) return;
				e.preventDefault();
				const step = e.shiftKey ? 10 : 1;
				const dx = key === "arrowleft" ? -step : key === "arrowright" ? step : 0;
				const dy = key === "arrowup" ? -step : key === "arrowdown" ? step : 0;
				const [x, y] = clampPos(item, item.x + dx, item.y + dy);
				store.updateItem(item.id, { x, y });
				return;
			}
			if (!e.metaKey && !e.ctrlKey && !e.altKey && TOOL_KEYS[key]) {
				setTool(TOOL_KEYS[key]);
			}
		},
		[selectedId, items, kill, setTool, store, clampPos],
	);

	const onKeyUp = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.code === "Space") {
			e.preventDefault();
			setSpacePressed(false);
		}
	}, []);

	// ---------- Render ----------

	if (loadError) {
		return (
			<WhiteboardSetup
				title="Connect a whiteboard database"
				body={
					<>
						Map a database to the <strong>items</strong> key in this block’s
						settings. An empty database works best.
					</>
				}
			/>
		);
	}

	if (setupIssues.length > 0) {
		return (
			<WhiteboardSetup
				title="Fix the whiteboard database"
				body="Open this block’s settings and update the mapped properties below. Select option names are case-sensitive."
				issues={setupIssues}
			/>
		);
	}

	const showEmpty = !isLoading && items.length === 0 && !draft;
	const saveMessage =
		saveState === "saving"
			? "Saving…"
			: saveState === "error"
				? "Couldn’t save"
				: "Saved";
	const selectionMessage = selectedItem
		? `${selectedItem.type === "sticky" ? "Sticky note" : selectedItem.title} selected. Use the arrow keys to move it, or Delete to remove it.`
		: "No item selected.";

	return (
		<div
			ref={rootRef}
			className="wb-root"
			data-tool={tool}
			data-dragging={drag ? "true" : "false"}
			data-panning={panDrag ? "true" : "false"}
			data-pan-ready={spacePressed ? "true" : "false"}
			style={{ backgroundPosition: `${pan[0]}px ${pan[1]}px` }}
			role="application"
			aria-label="Whiteboard canvas"
			aria-describedby="whiteboard-help"
			tabIndex={0}
			onPointerDown={onCanvasPointerDown}
			onPointerMove={onCanvasPointerMove}
			onPointerUp={onCanvasPointerUp}
			onPointerCancel={onCanvasPointerCancel}
			onLostPointerCapture={onCanvasPointerCancel}
			onPointerLeave={onCanvasPointerLeave}
			onDoubleClick={onCanvasDoubleClick}
			onKeyDown={onKeyDown}
			onKeyUp={onKeyUp}
		>
			<p id="whiteboard-help" className="wb-sr-only">
				Use V for select, H to pan, P for pen, E for eraser, S for a sticky
				note, L for line, or A for arrow. Hold Space to pan temporarily.
			</p>
			<p className="wb-sr-only" aria-live="polite">
				{tool} tool. {selectionMessage}
			</p>
			{isLoading ? (
				<div className="wb-skeleton" aria-hidden="true">
					<div
						className="wb-skel-rect"
						style={{ left: 56, top: 64, width: 160, height: 160 }}
					/>
					<div
						className="wb-skel-rect"
						style={{ left: 318, top: 212, width: 160, height: 160 }}
					/>
					<div
						className="wb-skel-rect"
						style={{ left: 330, top: 96, width: 140, height: 20 }}
					/>
				</div>
			) : (
				<svg className="wb-canvas" aria-hidden="true">
					<g transform={`translate(${pan[0]} ${pan[1]})`}>
						{sorted.map((item) => (
							<ItemView
								key={item.id}
								item={item}
								tool={tool}
								selected={selectedId === item.id}
								editing={editingId === item.id}
								dragging={drag?.id === item.id}
								dying={dyingIds.has(item.id)}
								onPointerDown={onItemPointerDown}
								onDoubleClick={onStickyDoubleClick}
								onCommit={commitEdit}
							/>
						))}
						<DraftView
							draft={draft}
							inkColor={inkColor}
							strokeWidth={strokeWidth}
						/>
						{tool === "eraser" && eraserPos && (
							<circle
								cx={eraserPos[0]}
								cy={eraserPos[1]}
								r={eraserRadius}
								fill="var(--translucent-gray-20)"
								stroke="var(--border-strong)"
								strokeWidth={1}
								style={{ pointerEvents: "none" }}
							/>
						)}
					</g>
				</svg>
			)}

			{showEmpty && (
				<div className="wb-empty">
					<div className="wb-empty-inner">
						<div className="wb-ghost" />
						<div className="wb-empty-hint">Pick a tool and start sketching</div>
					</div>
				</div>
			)}

			<div
				className={`wb-save${saveState !== "idle" ? " visible" : ""}${saveState === "error" ? " error" : ""}`}
				aria-live="polite"
			>
				{saveMessage}
			</div>

			<ToolOptions
				tool={tool}
				inkColor={inkColor}
				stickyColor={stickyColor}
				strokeWidth={strokeWidth}
				eraserRadius={eraserRadius}
				selectedItem={selectedItem}
				onInkColor={setInkColor}
				onStickyColor={setStickyColor}
				onStrokeWidth={setStrokeWidth}
				onEraserRadius={setEraserRadius}
				onSelectedItemChange={(patch) => {
					if (selectedItem) store.updateItem(selectedItem.id, patch);
				}}
				onEditSelected={() => {
					if (selectedItem?.type === "sticky") setEditingId(selectedItem.id);
				}}
			/>
			<Toolbar tool={tool} onToolChange={setTool} />
		</div>
	);
}

// ---------- Item views ----------

type ItemViewProps = {
	item: BoardItem;
	tool: Tool;
	selected: boolean;
	editing: boolean;
	dragging: boolean;
	dying: boolean;
	onPointerDown: (e: ReactPointerEvent, item: BoardItem) => void;
	onDoubleClick: (e: React.MouseEvent, item: BoardItem) => void;
	onCommit: (id: string, text: string) => void;
};

function ItemView(props: ItemViewProps) {
	if (props.item.type === "sticky") return <StickyView {...props} />;
	return <InkView {...props} />;
}

function StickyView({
	item,
	tool,
	selected,
	editing,
	dragging,
	dying,
	onPointerDown,
	onDoubleClick,
	onCommit,
}: ItemViewProps) {
	const [text, setText] = useState(item.title);
	const rotation = stickyRotation(item.id);
	const pad = 24;
	const interactive = tool === "select";
	const font = stickyFont((editing ? text : item.title).length);

	const cardClass = [
		"wb-sticky-card",
		interactive ? "wb-select-target" : "",
		selected ? "selected" : "",
		dragging ? "dragging" : "",
	]
		.filter(Boolean)
		.join(" ");

	return (
		<g
			className={`wb-item${dying ? " dying" : ""}`}
			transform={`translate(${item.x} ${item.y}) rotate(${rotation.toFixed(2)} ${item.width / 2} ${item.height / 2})`}
			style={{ pointerEvents: interactive ? "auto" : "none" }}
		>
			<foreignObject
				x={-pad}
				y={-pad}
				width={item.width + pad * 2}
				height={item.height + pad * 2}
			>
				<div
					{...{ xmlns: "http://www.w3.org/1999/xhtml" }}
					style={{
						padding: pad,
						width: item.width,
						height: item.height,
						boxSizing: "content-box",
						pointerEvents: "none",
					}}
				>
					<div
						className={cardClass}
						style={{ pointerEvents: interactive ? "auto" : "none" }}
						onPointerDown={(e) => onPointerDown(e, item)}
						onDoubleClick={(e) => onDoubleClick(e, item)}
					>
						<div
							className="wb-sticky-fill"
							style={{ background: `var(--wb-fill-${item.color})` }}
						/>
						{editing ? (
							<textarea
								className="wb-sticky-input"
								style={font}
								value={text}
								maxLength={500}
								placeholder="Type something…"
								autoFocus
								onFocus={(e) => {
									setText(item.title);
									e.currentTarget.value = item.title;
									e.currentTarget.setSelectionRange(
										item.title.length,
										item.title.length,
									);
								}}
								onChange={(e) => setText(e.target.value)}
								onBlur={() => onCommit(item.id, text)}
								onPointerDown={(e) => e.stopPropagation()}
								onKeyDown={(e) => {
									if (e.key === "Escape") {
										e.preventDefault();
										onCommit(item.id, text);
									}
									e.stopPropagation();
								}}
							/>
						) : (
							<div className="wb-sticky-text" style={font}>
								{item.title}
							</div>
						)}
					</div>
				</div>
			</foreignObject>
		</g>
	);
}

function InkView({
	item,
	tool,
	selected,
	dying,
	onPointerDown,
}: ItemViewProps) {
	const abs = item.points.map(([px, py]) => [px + item.x, py + item.y] as Point);
	const ink = inkVar(item.color);
	const interactive = tool === "select";

	let visible: React.ReactNode = null;
	if (item.type === "arrow" && abs.length >= 2) {
		visible = (
			<ArrowShape
				start={abs[0]}
				end={abs[abs.length - 1]}
				ink={ink}
				strokeWidth={item.strokeWidth}
			/>
		);
	} else {
		visible = (
			<path
				d={smoothPath(abs)}
				stroke={ink}
				strokeWidth={item.strokeWidth}
				fill="none"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		);
	}

	return (
		<g
			className={`wb-item${dying ? " dying" : ""}`}
			style={{ pointerEvents: interactive ? "auto" : "none" }}
		>
			{visible}
			{/* Fat invisible hit path for easy selection */}
			<path
				className="wb-select-target"
				d={smoothPath(abs)}
				stroke="transparent"
				strokeWidth={Math.max(14, item.strokeWidth + 10)}
				fill="none"
				style={{ pointerEvents: interactive ? "stroke" : "none" }}
				onPointerDown={(e) => onPointerDown(e, item)}
			/>
			{selected && !dying && (
				<rect
					x={item.x - 6}
					y={item.y - 6}
					width={item.width + 12}
					height={item.height + 12}
					fill="none"
					stroke="var(--wb-selection)"
					strokeWidth={1.5}
					style={{ rx: "var(--radius-4)", pointerEvents: "none" } as CSSProperties}
				/>
			)}
		</g>
	);
}

function ArrowShape({
	start,
	end,
	ink,
	strokeWidth,
}: {
	start: Point;
	end: Point;
	ink: string;
	strokeWidth: number;
}) {
	const headSize = Math.max(9, strokeWidth * 2.5 + 4);
	const len = Math.hypot(end[0] - start[0], end[1] - start[1]);
	const t = len > 0 ? Math.max(0, (len - headSize * 0.6) / len) : 0;
	const shaftEnd: Point = [
		start[0] + (end[0] - start[0]) * t,
		start[1] + (end[1] - start[1]) * t,
	];
	const [f1, f2] = arrowHead(start, end, headSize);
	return (
		<>
			<path
				d={`M ${start[0]} ${start[1]} L ${shaftEnd[0]} ${shaftEnd[1]}`}
				stroke={ink}
				strokeWidth={strokeWidth}
				fill="none"
				strokeLinecap="round"
			/>
			<polygon
				points={`${end[0]},${end[1]} ${f1[0]},${f1[1]} ${f2[0]},${f2[1]}`}
				fill={ink}
				stroke={ink}
				strokeWidth={1}
				strokeLinejoin="round"
			/>
		</>
	);
}

function DraftView({
	draft,
	inkColor,
	strokeWidth,
}: {
	draft: Draft | null;
	inkColor: ItemColor;
	strokeWidth: number;
}) {
	if (!draft) return null;
	const ink = inkVar(inkColor);
	if (draft.kind === "pen") {
		return (
			<path
				d={smoothPath(draft.points)}
				stroke={ink}
				strokeWidth={strokeWidth}
				fill="none"
				strokeLinecap="round"
				strokeLinejoin="round"
				style={{ pointerEvents: "none" }}
			/>
		);
	}
	if (draft.kind === "arrow") {
		return (
			<g style={{ pointerEvents: "none" }}>
				<ArrowShape
					start={draft.start}
					end={draft.end}
					ink={ink}
					strokeWidth={strokeWidth}
				/>
			</g>
		);
	}
	return (
		<path
			d={`M ${draft.start[0]} ${draft.start[1]} L ${draft.end[0]} ${draft.end[1]}`}
			stroke={ink}
			strokeWidth={strokeWidth}
			fill="none"
			strokeLinecap="round"
			style={{ pointerEvents: "none" }}
		/>
	);
}
