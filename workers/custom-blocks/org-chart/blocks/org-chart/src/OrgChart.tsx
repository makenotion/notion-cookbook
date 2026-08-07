import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type {
	KeyboardEvent as ReactKeyboardEvent,
	PointerEvent as ReactPointerEvent,
	ReactNode,
} from "react";
import { SAMPLE_PEOPLE } from "./mockData";
import {
	ancestorsOf,
	buildForest,
	CARD_H,
	CARD_W,
	chainToRoot,
	layoutForest,
	RANK_GAP,
	type Forest,
	type LayoutResult,
	type OrgNode,
} from "./tree";
import type { OrgDataState, Person } from "./types";

const ZOOM_LEVELS = [0.25, 0.35, 0.5, 0.65, 0.75, 0.9, 1, 1.15, 1.3, 1.4] as const;
const MIN_SCALE = ZOOM_LEVELS[0];
const MAX_SCALE = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
const FIT_PADDING = 56;
const ANIM_MS = 200;
/** Scale of the initial "home" view: the root card at the top of the view. */
const HOME_SCALE = 1;
/** Below this scale the chart counts as "zoomed out": clicking a card zooms
 * in on that person instead of toggling their selection. */
const SELECT_ZOOM_THRESHOLD = 0.9;
const SELECT_ZOOM_TARGET = 1;

// ---------------------------------------------------------------------------
// Avatar tint: stable hash of the name into the NDS translucent ramps.

const AVATAR_HUES = [
	"blue",
	"green",
	"purple",
	"red",
	"orange",
	"teal",
	"pink",
	"yellow",
	"brown",
] as const;

/** Stable per-person tint, keyed by row id so duplicate names still differ. */
function hueFor(seed: string): (typeof AVATAR_HUES)[number] {
	let h = 5381;
	for (let i = 0; i < seed.length; i++) {
		h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
	}
	return AVATAR_HUES[Math.abs(h) % AVATAR_HUES.length];
}

function initialsFor(name: string): string {
	const parts = name.trim().split(/\s+/);
	const first = parts[0]?.[0] ?? "";
	const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
	return (first + last).toUpperCase();
}

function Avatar({ person }: { person: Person }): ReactNode {
	const [imgFailed, setImgFailed] = useState(false);
	const hue = hueFor(person.id);
	const tintStyle = {
		background: `var(--translucent-${hue}-20)`,
		color: `var(--${hue}-100)`,
	};
	if (person.icon?.type === "url" && !imgFailed) {
		return (
			<img
				className="oc-avatar oc-avatar-img"
				src={person.icon.url}
				alt=""
				draggable={false}
				onError={() => setImgFailed(true)}
			/>
		);
	}
	if (person.icon?.type === "emoji") {
		return (
			<span className="oc-avatar oc-avatar-emoji" style={tintStyle} aria-hidden>
				{person.icon.emoji}
			</span>
		);
	}
	return (
		<span className="oc-avatar" style={tintStyle} aria-hidden>
			{initialsFor(person.name)}
		</span>
	);
}

// ---------------------------------------------------------------------------
// Animated positions: FLIP-style JS tween between layout snapshots so cards
// and connectors move together (no layout thrash, connectors follow exactly).

type Disp = { x: number; y: number; o: number };

function snapshotOf(layout: LayoutResult): Map<string, Disp> {
	const out = new Map<string, Disp>();
	for (const [id, p] of layout.positions) out.set(id, { x: p.x, y: p.y, o: 1 });
	return out;
}

function easeOutCubic(t: number): number {
	return 1 - Math.pow(1 - t, 3);
}

function useAnimatedPositions(
	layout: LayoutResult,
	reducedMotion: boolean,
	anchorRef: { current: string | null },
	onAnchorShift: (dx: number, dy: number) => void,
): Map<string, Disp> {
	const [disp, setDisp] = useState<Map<string, Disp>>(() => snapshotOf(layout));
	const dispRef = useRef(disp);
	const prevLayoutRef = useRef(layout);
	const rafRef = useRef<number | null>(null);
	const safetyTimerRef = useRef<number | null>(null);

	useEffect(() => {
		if (layout === prevLayoutRef.current) return;
		prevLayoutRef.current = layout;
		if (rafRef.current !== null) {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
		}
		if (safetyTimerRef.current !== null) {
			window.clearTimeout(safetyTimerRef.current);
			safetyTimerRef.current = null;
		}

		// Anchored relayout: the new layout may shift the whole tree, which
		// would drag the card the user just toggled across the screen. Measure
		// how far the anchor moved, let the parent pan the viewport by the same
		// amount, and start the tween from equally shifted positions so the
		// anchor (and every card, at t=0) stays screen-continuous.
		const anchorId = anchorRef.current;
		anchorRef.current = null;
		let shiftX = 0;
		let shiftY = 0;
		if (anchorId !== null) {
			const fromAnchor = dispRef.current.get(anchorId);
			const toAnchor = layout.positions.get(anchorId);
			if (fromAnchor !== undefined && toAnchor !== undefined) {
				shiftX = toAnchor.x - fromAnchor.x;
				shiftY = toAnchor.y - fromAnchor.y;
				if (shiftX !== 0 || shiftY !== 0) onAnchorShift(shiftX, shiftY);
			}
		}

		const finish = (): void => {
			const final = snapshotOf(layout);
			dispRef.current = final;
			setDisp(final);
		};
		// rAF is throttled or paused when the page is hidden — jump to the
		// final layout rather than freezing mid-tween.
		if (reducedMotion || document.visibilityState === "hidden") {
			finish();
			return;
		}

		// Quiet motion: persisting cards ease to their new spot; entering and
		// exiting cards just fade in place — no converge/emerge choreography.
		const from = new Map<string, Disp>();
		for (const [id, d] of dispRef.current) {
			from.set(id, { x: d.x + shiftX, y: d.y + shiftY, o: d.o });
		}
		const targets = new Map<string, Disp>();
		for (const [id, p] of layout.positions) {
			targets.set(id, { x: p.x, y: p.y, o: 1 });
		}
		for (const [id, d] of from) {
			if (!targets.has(id)) targets.set(id, { x: d.x, y: d.y, o: 0 });
		}
		for (const [id, t] of targets) {
			if (!from.has(id)) from.set(id, { x: t.x, y: t.y, o: 0 });
		}
		if (shiftX !== 0 || shiftY !== 0) {
			// Commit the shifted start positions in the same render as the
			// viewport compensation, before the first rAF frame runs.
			dispRef.current = from;
			setDisp(from);
		}

		const t0 = performance.now();
		// Safety net: if rAF stops firing (tab hidden mid-animation), settle
		// into the final layout via a plain timeout.
		safetyTimerRef.current = window.setTimeout(() => {
			safetyTimerRef.current = null;
			if (rafRef.current !== null) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
				finish();
			}
		}, ANIM_MS + 300);
		const step = (now: number): void => {
			const t = Math.min(1, (now - t0) / ANIM_MS);
			if (t >= 1) {
				if (safetyTimerRef.current !== null) {
					window.clearTimeout(safetyTimerRef.current);
					safetyTimerRef.current = null;
				}
				finish();
				rafRef.current = null;
				return;
			}
			const e = easeOutCubic(t);
			const cur = new Map<string, Disp>();
			for (const [id, to] of targets) {
				const f = from.get(id) ?? to;
				cur.set(id, {
					x: f.x + (to.x - f.x) * e,
					y: f.y + (to.y - f.y) * e,
					o: f.o + (to.o - f.o) * e,
				});
			}
			dispRef.current = cur;
			setDisp(cur);
			rafRef.current = requestAnimationFrame(step);
		};
		rafRef.current = requestAnimationFrame(step);
	}, [layout, reducedMotion, anchorRef, onAnchorShift]);

	useEffect(
		() => () => {
			if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
			if (safetyTimerRef.current !== null) {
				window.clearTimeout(safetyTimerRef.current);
			}
		},
		[],
	);

	return disp;
}

// ---------------------------------------------------------------------------
// Connector path with softly rounded elbows.

function edgePath(from: Disp, to: Disp): string {
	const sx = from.x + CARD_W / 2;
	const sy = from.y + CARD_H;
	const ex = to.x + CARD_W / 2;
	const ey = to.y;
	const dx = ex - sx;
	if (Math.abs(dx) < 0.75) return `M ${sx} ${sy} L ${ex} ${ey}`;
	const midY = sy + (ey - sy) / 2;
	const r = Math.min(10, Math.abs(dx) / 2, Math.abs(ey - sy) / 2);
	const dir = dx > 0 ? 1 : -1;
	return (
		`M ${sx} ${sy} L ${sx} ${midY - r} ` +
		`Q ${sx} ${midY} ${sx + dir * r} ${midY} ` +
		`L ${ex - dir * r} ${midY} ` +
		`Q ${ex} ${midY} ${ex} ${midY + r} ` +
		`L ${ex} ${ey}`
	);
}

// ---------------------------------------------------------------------------
// Chart canvas: pan/zoom viewport + cards + connectors + search.

type View = { tx: number; ty: number; s: number };

function clampScale(s: number): number {
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

function steppedScale(current: number, direction: -1 | 1): number {
	if (direction > 0) {
		return ZOOM_LEVELS.find((level) => level > current + 0.01) ?? MAX_SCALE;
	}
	return [...ZOOM_LEVELS].reverse().find((level) => level < current - 0.01) ?? MIN_SCALE;
}

function ChartCanvas({
	people,
	interactive,
}: {
	people: Person[];
	interactive: boolean;
}): ReactNode {
	const forest: Forest = useMemo(() => buildForest(people), [people]);
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [hoveredId, setHoveredId] = useState<string | null>(null);

	const reducedMotion = useMemo(
		() =>
			typeof window.matchMedia === "function" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches,
		[],
	);

	// Drop stale selection if rows disappear.
	useEffect(() => {
		if (selectedId !== null && !forest.nodesById.has(selectedId)) {
			setSelectedId(null);
		}
	}, [forest, selectedId]);

	const layout = useMemo(
		() => layoutForest(forest.roots, collapsed),
		[forest, collapsed],
	);

	const activeChain = useMemo(() => {
		const focus = hoveredId ?? selectedId;
		if (focus === null || !forest.nodesById.has(focus)) {
			return new Set<string>();
		}
		return chainToRoot(focus, forest.parentById);
	}, [hoveredId, selectedId, forest]);

	// --- Viewport ---
	const viewportRef = useRef<HTMLDivElement>(null);
	const [view, setView] = useState<View>({ tx: 0, ty: 0, s: 1 });
	const viewRef = useRef(view);
	viewRef.current = view;
	const [viewAnim, setViewAnim] = useState(false);
	const [isDragging, setIsDragging] = useState(false);
	const viewAnimTimerRef = useRef<number | null>(null);
	const dragRef = useRef<{
		pointerId: number;
		lastX: number;
		lastY: number;
	} | null>(null);
	const wheelIntentRef = useRef<{ delta: number; resetTimer: number | null }>({
		delta: 0,
		resetTimer: null,
	});
	/** Once the user pans/zooms manually we stop auto-fitting on resize. */
	const userMovedRef = useRef(false);

	// Expand/collapse anchoring: the toggled card's id is stashed here, and
	// when the relayout lands the viewport pans by however far that card
	// moved, so it stays locked in place on screen.
	const anchorIdRef = useRef<string | null>(null);
	const onAnchorShift = useCallback((dx: number, dy: number) => {
		setViewAnim(false);
		setView((v) => ({ ...v, tx: v.tx - dx * v.s, ty: v.ty - dy * v.s }));
	}, []);
	const disp = useAnimatedPositions(
		layout,
		reducedMotion,
		anchorIdRef,
		onAnchorShift,
	);

	const beginViewAnim = useCallback(() => {
		if (reducedMotion) return;
		setViewAnim(true);
		if (viewAnimTimerRef.current !== null) {
			window.clearTimeout(viewAnimTimerRef.current);
		}
		viewAnimTimerRef.current = window.setTimeout(() => setViewAnim(false), 220);
	}, [reducedMotion]);

	// Which automatic view the viewport is resting in: the initial "home"
	// view (root card at the top, zoomed in) or the fit-everything view.
	// Resizes re-apply whichever was last active.
	const autoViewRef = useRef<"home" | "fit">("home");

	const fitView = useCallback(
		(animate: boolean) => {
			const el = viewportRef.current;
			if (el === null) return;
			const vw = el.clientWidth;
			const vh = el.clientHeight;
			const w = Math.max(layout.width, CARD_W);
			const h = Math.max(layout.height, CARD_H);
			// The fit respects the zoom floor so cards never become unreadably
			// small; an org too wide for the floor centers on the primary root
			// and pans instead.
			const s = clampScale(
				Math.min(1, (vw - FIT_PADDING * 2) / w, (vh - FIT_PADDING * 2) / h),
			);
			let tx = (vw - w * s) / 2;
			if (w * s + FIT_PADDING > vw) {
				const rootId = forest.roots[0]?.person.id;
				const rootPos =
					rootId !== undefined ? layout.positions.get(rootId) : undefined;
				tx =
					rootPos !== undefined
						? vw / 2 - (rootPos.x + CARD_W / 2) * s
						: FIT_PADDING / 2;
			}
			const ty = h * s + FIT_PADDING > vh ? FIT_PADDING / 2 : (vh - h * s) / 2;
			userMovedRef.current = false;
			autoViewRef.current = "fit";
			if (animate) beginViewAnim();
			setView({ tx, ty, s });
		},
		[layout, forest, beginViewAnim],
	);

	// Default view: the primary root centered at the top edge at 100%, so the
	// chart opens reading down from the top of the org rather than fully fit.
	const homeView = useCallback(
		(animate: boolean) => {
			const el = viewportRef.current;
			if (el === null) return;
			const rootId = forest.roots[0]?.person.id;
			const rootPos =
				rootId !== undefined ? layout.positions.get(rootId) : undefined;
			if (rootPos === undefined) {
				fitView(animate);
				return;
			}
			const s = clampScale(HOME_SCALE);
			userMovedRef.current = false;
			autoViewRef.current = "home";
			if (animate) beginViewAnim();
			setView({
				tx: el.clientWidth / 2 - (rootPos.x + CARD_W / 2) * s,
				ty: FIT_PADDING / 2 - rootPos.y * s,
				s,
			});
		},
		[layout, forest, beginViewAnim, fitView],
	);

	const didFitRef = useRef(false);
	useLayoutEffect(() => {
		if (!didFitRef.current && layout.positions.size > 0) {
			didFitRef.current = true;
			homeView(false);
		}
	}, [layout, homeView]);

	// Keep the tree fitted as the host resizes the iframe, until the user
	// takes over the viewport themselves. Only genuine size changes refit —
	// the observe() call itself always fires once, which must not snap the
	// viewport after unrelated re-renders.
	const fitViewRef = useRef<(animate: boolean) => void>(fitView);
	fitViewRef.current = (animate) =>
		autoViewRef.current === "home" ? homeView(animate) : fitView(animate);
	useEffect(() => {
		const el = viewportRef.current;
		if (el === null || typeof ResizeObserver === "undefined") return;
		let last: { w: number; h: number } | null = null;
		const ro = new ResizeObserver((entries) => {
			const rect = entries[entries.length - 1].contentRect;
			if (
				last !== null &&
				(last.w !== rect.width || last.h !== rect.height) &&
				!userMovedRef.current &&
				didFitRef.current
			) {
				fitViewRef.current(false);
			}
			last = { w: rect.width, h: rect.height };
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const zoomAt = useCallback(
		(clientX: number, clientY: number, target: number) => {
			const el = viewportRef.current;
			if (el === null) return;
			const rect = el.getBoundingClientRect();
			const px = clientX - rect.left;
			const py = clientY - rect.top;
			const { tx, ty, s } = viewRef.current;
			const s2 = clampScale(target);
			const wx = (px - tx) / s;
			const wy = (py - ty) / s;
			setView({ tx: px - wx * s2, ty: py - wy * s2, s: s2 });
		},
		[],
	);

	const zoomByStep = useCallback(
		(clientX: number, clientY: number, direction: -1 | 1) => {
			userMovedRef.current = true;
			beginViewAnim();
			zoomAt(clientX, clientY, steppedScale(viewRef.current.s, direction));
		},
		[beginViewAnim, zoomAt],
	);

	useEffect(() => {
		const el = viewportRef.current;
		if (el === null || !interactive) return;
		const onWheel = (e: WheelEvent): void => {
			e.preventDefault();
			userMovedRef.current = true;
			const delta =
				e.deltaMode === 1
					? e.deltaY * 16
					: e.deltaMode === 2
						? e.deltaY * 120
						: e.deltaY;
			const intent = wheelIntentRef.current;
			intent.delta += delta;
			if (intent.resetTimer !== null) window.clearTimeout(intent.resetTimer);
			intent.resetTimer = window.setTimeout(() => {
				intent.delta = 0;
				intent.resetTimer = null;
			}, 120);

			// Trackpads emit many tiny wheel events while mouse wheels emit one
			// large event. Accumulate either form into one deliberate zoom step.
			const threshold = e.ctrlKey ? 24 : 60;
			if (Math.abs(intent.delta) < threshold) return;
			const direction: -1 | 1 = intent.delta < 0 ? 1 : -1;
			intent.delta = 0;
			zoomByStep(e.clientX, e.clientY, direction);
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			el.removeEventListener("wheel", onWheel);
			if (wheelIntentRef.current.resetTimer !== null) {
				window.clearTimeout(wheelIntentRef.current.resetTimer);
			}
		};
	}, [zoomByStep, interactive]);

	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
		if (!interactive || e.button !== 0) return;
		if ((e.target as Element).closest(".oc-interactive") !== null) return;
		dragRef.current = {
			pointerId: e.pointerId,
			lastX: e.clientX,
			lastY: e.clientY,
		};
		setViewAnim(false);
		setIsDragging(true);
		e.currentTarget.setPointerCapture(e.pointerId);
	};
	const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
		const drag = dragRef.current;
		if (drag === null || drag.pointerId !== e.pointerId) return;
		const dx = e.clientX - drag.lastX;
		const dy = e.clientY - drag.lastY;
		drag.lastX = e.clientX;
		drag.lastY = e.clientY;
		if (dx !== 0 || dy !== 0) userMovedRef.current = true;
		setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
	};
	const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
		if (dragRef.current?.pointerId === e.pointerId) {
			dragRef.current = null;
			setIsDragging(false);
			if (e.currentTarget.hasPointerCapture(e.pointerId)) {
				e.currentTarget.releasePointerCapture(e.pointerId);
			}
		}
	};

	const onViewportKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
		if (e.target !== e.currentTarget) return;
		const pan = 64;
		if (e.key === "ArrowLeft") {
			userMovedRef.current = true;
			setView((v) => ({ ...v, tx: v.tx + pan }));
		} else if (e.key === "ArrowRight") {
			userMovedRef.current = true;
			setView((v) => ({ ...v, tx: v.tx - pan }));
		} else if (e.key === "ArrowUp") {
			userMovedRef.current = true;
			setView((v) => ({ ...v, ty: v.ty + pan }));
		} else if (e.key === "ArrowDown") {
			userMovedRef.current = true;
			setView((v) => ({ ...v, ty: v.ty - pan }));
		} else if (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "_") {
			const el = viewportRef.current;
			if (el === null) return;
			const rect = el.getBoundingClientRect();
			zoomByStep(
				rect.left + rect.width / 2,
				rect.top + rect.height / 2,
				e.key === "+" || e.key === "=" ? 1 : -1,
			);
		} else if (e.key.toLowerCase() === "f" || e.key === "0") {
			fitView(true);
		} else {
			return;
		}
		e.preventDefault();
	};

	// --- Collapse / select / reveal (stable ids-based callbacks so memoized
	// cards skip re-renders in large orgs) ---
	const toggleCollapsed = useCallback(
		(id: string) => {
			anchorIdRef.current = id;
			const isCollapsing = !collapsed.has(id);
			if (
				isCollapsing &&
				selectedId !== null &&
				selectedId !== id &&
				ancestorsOf(selectedId, forest.parentById).includes(id)
			) {
				setSelectedId(id);
			}
			setCollapsed((prev) => {
				const next = new Set(prev);
				if (next.has(id)) next.delete(id);
				else next.add(id);
				return next;
			});
		},
		[collapsed, forest, selectedId],
	);

	// Latest layout, readable from the stable card callbacks below.
	const layoutRef = useRef(layout);
	layoutRef.current = layout;

	const toggleSelected = useCallback(
		(id: string) => {
			// From a zoomed-out overview a card click is a navigation gesture:
			// zoom in on that person rather than toggling selection.
			if (viewRef.current.s < SELECT_ZOOM_THRESHOLD) {
				const p = layoutRef.current.positions.get(id);
				const el = viewportRef.current;
				if (p !== undefined && el !== null) {
					const s2 = clampScale(SELECT_ZOOM_TARGET);
					userMovedRef.current = true;
					beginViewAnim();
					setView({
						tx: el.clientWidth / 2 - (p.x + CARD_W / 2) * s2,
						ty: el.clientHeight / 2 - (p.y + CARD_H / 2) * s2,
						s: s2,
					});
				}
				setSelectedId(id);
				return;
			}
			setSelectedId((cur) => (cur === id ? null : id));
		},
		[beginViewAnim],
	);

	const setHoveredIdStable = useCallback(
		(id: string, hovering: boolean) => {
			setHoveredId((cur) => (hovering ? id : cur === id ? null : cur));
		},
		[],
	);

	const revealPerson = useCallback(
		(id: string) => {
			const hiddenAncestors = ancestorsOf(id, forest.parentById).filter((a) =>
				collapsed.has(a),
			);
			let nextLayout = layout;
			if (hiddenAncestors.length > 0) {
				const nextCollapsed = new Set(collapsed);
				for (const a of hiddenAncestors) nextCollapsed.delete(a);
				setCollapsed(nextCollapsed);
				nextLayout = layoutForest(forest.roots, nextCollapsed);
			}
			const p = nextLayout.positions.get(id);
			const el = viewportRef.current;
			if (p !== undefined && el !== null) {
				const s2 = clampScale(Math.max(viewRef.current.s, 0.9));
				beginViewAnim();
				setView({
					tx: el.clientWidth / 2 - (p.x + CARD_W / 2) * s2,
					ty: el.clientHeight / 2 - (p.y + CARD_H / 2) * s2,
					s: s2,
				});
			}
			// Selection is the landing feedback: persistent border + chain.
			setSelectedId(id);
		},
		[forest, collapsed, layout, beginViewAnim],
	);

	// --- Search ---
	const [query, setQuery] = useState("");
	const [searchFocused, setSearchFocused] = useState(false);
	const [activeIdx, setActiveIdx] = useState(0);
	const searchInputRef = useRef<HTMLInputElement>(null);

	const matches = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (q === "") return [];
		const scored = people
			.map((p) => {
				const name = p.name.toLowerCase();
				const role = p.role.toLowerCase();
				let score: number | null = null;
				if (name.startsWith(q)) score = 0;
				else if (name.includes(q)) score = 1;
				else if (role.includes(q)) score = 2;
				return score === null ? null : { p, score };
			})
			.filter((m): m is { p: Person; score: number } => m !== null);
		scored.sort(
			(a, b) => a.score - b.score || a.p.name.localeCompare(b.p.name),
		);
		return scored.slice(0, 8).map((m) => m.p);
	}, [query, people]);

	useEffect(() => setActiveIdx(0), [query]);

	const selectMatch = useCallback(
		(person: Person) => {
			setQuery("");
			searchInputRef.current?.blur();
			revealPerson(person.id);
			requestAnimationFrame(() =>
				viewportRef.current?.focus({ preventScroll: true }),
			);
		},
		[revealPerson],
	);

	const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActiveIdx((i) => Math.min(i + 1, Math.max(matches.length - 1, 0)));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActiveIdx((i) => Math.max(i - 1, 0));
		} else if (e.key === "Enter") {
			const match = matches[activeIdx] ?? matches[0];
			if (match !== undefined) {
				e.preventDefault();
				selectMatch(match);
			}
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			if (query !== "") setQuery("");
			else searchInputRef.current?.blur();
		}
	};

	// Global shortcuts: "/" focuses search, Esc clears selection.
	useEffect(() => {
		if (!interactive) return;
		const onKey = (e: KeyboardEvent): void => {
			const target = e.target as HTMLElement | null;
			const inField =
				target !== null &&
				(target.tagName === "INPUT" ||
					target.tagName === "TEXTAREA" ||
					target.isContentEditable);
			if (e.key === "/" && !inField) {
				e.preventDefault();
				searchInputRef.current?.focus();
			} else if (e.key === "Escape" && !inField) {
				setSelectedId(null);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [interactive]);

	useEffect(
		() => () => {
			if (viewAnimTimerRef.current !== null) {
				window.clearTimeout(viewAnimTimerRef.current);
			}
		},
		[],
	);

	const activeSearchOptionId =
		searchFocused && matches.length > 0
			? `oc-search-option-${activeIdx}`
			: undefined;
	const selectedPerson =
		selectedId === null ? undefined : forest.nodesById.get(selectedId)?.person;

	// --- Render ---
	const nodes: ReactNode[] = [];
	const edgeEls: ReactNode[] = [];
	for (const [id, d] of disp) {
		const node = forest.nodesById.get(id);
		if (node === undefined) continue;
		const parentId = forest.parentById.get(id) ?? null;
		if (parentId !== null) {
			const pd = disp.get(parentId);
			if (pd !== undefined) {
				const inChain = activeChain.has(id) && activeChain.has(parentId);
				edgeEls.push(
					<path
						key={id}
						className={inChain ? "oc-edge is-chain" : "oc-edge"}
						d={edgePath(pd, d)}
						style={{ opacity: Math.min(d.o, pd.o) }}
					/>,
				);
			}
		}
		nodes.push(
			<OrgCard
				key={id}
				node={node}
				disp={d}
				interactive={interactive}
				isSelected={selectedId === id}
				isChain={activeChain.has(id)}
				isCollapsed={collapsed.has(id)}
				onSelectId={toggleSelected}
				onHoverId={setHoveredIdStable}
				onToggleId={toggleCollapsed}
			/>,
		);
	}

	return (
		<div
			className={
				interactive
					? `oc-viewport${isDragging ? " is-dragging" : ""}`
					: "oc-viewport is-static"
			}
			ref={viewportRef}
			role={interactive ? "application" : undefined}
			aria-label={
				interactive ? "Org chart. Drag to pan, scroll to zoom." : undefined
			}
			tabIndex={interactive ? 0 : -1}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			onLostPointerCapture={() => {
				dragRef.current = null;
				setIsDragging(false);
			}}
			onDoubleClick={(e) => {
				if (!interactive) return;
				if ((e.target as Element).closest(".oc-interactive") !== null) return;
				fitView(true);
			}}
			onKeyDown={interactive ? onViewportKeyDown : undefined}
		>
			<div
				className={viewAnim ? "oc-world is-anim" : "oc-world"}
				style={{
					transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`,
				}}
			>
				<svg className="oc-edges" width={1} height={1} aria-hidden="true">
					{edgeEls}
				</svg>
				{nodes}
			</div>
			{interactive && (
				<>
					<div className="oc-search oc-interactive">
						<svg
							className="oc-search-icon"
							viewBox="0 0 16 16"
							width="14"
							height="14"
							aria-hidden="true"
						>
							<circle
								cx="7"
								cy="7"
								r="4.5"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
							/>
							<line
								x1="10.5"
								y1="10.5"
								x2="14"
								y2="14"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
							/>
						</svg>
						<input
							ref={searchInputRef}
							type="text"
							role="combobox"
							aria-expanded={searchFocused && query.trim() !== ""}
							aria-label="Search people"
							aria-autocomplete="list"
							aria-controls="oc-search-listbox"
							aria-activedescendant={activeSearchOptionId}
							placeholder="Search people"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onFocus={() => setSearchFocused(true)}
							onBlur={() => setSearchFocused(false)}
							onKeyDown={onSearchKeyDown}
						/>
						{!searchFocused && query === "" && (
							<kbd className="oc-search-kbd" aria-hidden="true">
								/
							</kbd>
						)}
						{searchFocused && query.trim() !== "" && (
							<ul
								className="oc-search-results"
								role="listbox"
								id="oc-search-listbox"
							>
								{matches.length === 0 ? (
									<li className="oc-search-empty" role="status">
										No matches
									</li>
								) : (
									matches.map((p, i) => (
										<li
											key={p.id}
											id={`oc-search-option-${i}`}
											role="option"
											aria-selected={i === activeIdx}
											className={
												i === activeIdx
													? "oc-search-item is-active"
													: "oc-search-item"
											}
											onPointerEnter={() => setActiveIdx(i)}
											onPointerDown={(e) => {
												e.preventDefault();
												selectMatch(p);
											}}
										>
											<Avatar person={p} />
											<span className="oc-search-name">{p.name}</span>
											<span className="oc-search-role">{p.role}</span>
										</li>
									))
								)}
							</ul>
						)}
					</div>
						<div
							className="oc-zoom-controls oc-interactive"
							role="group"
							aria-label="Zoom controls"
						>
							<button
								type="button"
								className="oc-zoom-button"
								aria-label="Zoom out"
								disabled={view.s <= MIN_SCALE + 0.01}
								onClick={() => {
									const rect = viewportRef.current?.getBoundingClientRect();
									if (rect) {
										zoomByStep(
											rect.left + rect.width / 2,
											rect.top + rect.height / 2,
											-1,
										);
									}
								}}
							>
								−
							</button>
							<span className="oc-zoom-value" aria-live="polite">
								{Math.round(view.s * 100)}%
							</span>
							<button
								type="button"
								className="oc-zoom-button"
								aria-label="Zoom in"
								disabled={view.s >= MAX_SCALE - 0.01}
								onClick={() => {
									const rect = viewportRef.current?.getBoundingClientRect();
									if (rect) {
										zoomByStep(
											rect.left + rect.width / 2,
											rect.top + rect.height / 2,
											1,
										);
									}
								}}
							>
								+
							</button>
							<span className="oc-zoom-separator" aria-hidden="true" />
							<button
								type="button"
								className="oc-zoom-button"
								aria-label="Zoom to fit"
								title="Zoom to fit (F)"
								onClick={() => fitView(true)}
							>
								<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
									<path
										d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"
										fill="none"
										stroke="currentColor"
										strokeWidth="1.5"
										strokeLinecap="round"
										strokeLinejoin="round"
									/>
									</svg>
								</button>
							</div>
						<div className="oc-sr-only" aria-live="polite">
							{selectedPerson === undefined
								? ""
								: `${selectedPerson.name} selected`}
						</div>
				</>
			)}
		</div>
	);
}

const OrgCard = memo(function OrgCard({
	node,
	disp,
	interactive,
	isSelected,
	isChain,
	isCollapsed,
	onSelectId,
	onHoverId,
	onToggleId,
}: {
	node: OrgNode;
	disp: Disp;
	interactive: boolean;
	isSelected: boolean;
	isChain: boolean;
	isCollapsed: boolean;
	onSelectId: (id: string) => void;
	onHoverId: (id: string, hovering: boolean) => void;
	onToggleId: (id: string) => void;
}): ReactNode {
	const { person, directCount, totalCount } = node;
	const id = person.id;
	const ghost = disp.o < 0.999;
	const reportSummary =
		directCount > 0
			? `${directCount} direct, ${totalCount} total reports`
			: "No reports";
	const cardClass = [
		"oc-card",
		interactive ? "oc-interactive" : "",
		isChain ? "is-chain" : "",
		isSelected ? "is-selected" : "",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<div
			className="oc-node"
			style={{
				transform: `translate(${disp.x}px, ${disp.y}px)`,
				opacity: disp.o,
				pointerEvents: ghost ? "none" : undefined,
				zIndex: isSelected || isChain ? 2 : 1,
			}}
			onPointerEnter={interactive ? () => onHoverId(id, true) : undefined}
			onPointerLeave={interactive ? () => onHoverId(id, false) : undefined}
			onFocus={interactive ? () => onHoverId(id, true) : undefined}
			onBlur={
				interactive
					? (e) => {
							if (!e.currentTarget.contains(e.relatedTarget)) {
								onHoverId(id, false);
							}
						}
					: undefined
			}
		>
			<div
				className={cardClass}
				role={interactive ? "button" : undefined}
				tabIndex={interactive && !ghost ? 0 : -1}
				aria-pressed={interactive ? isSelected : undefined}
				aria-label={`${person.name}${person.role !== "" ? `, ${person.role}` : ""}${
					isSelected ? `. ${reportSummary}. Selected` : ""
				}`}
				onClick={interactive ? () => onSelectId(id) : undefined}
				onKeyDown={
					interactive
						? (e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									onSelectId(id);
								}
							}
						: undefined
				}
			>
				<Avatar person={person} />
				<div className="oc-name" title={person.name}>
					{person.name}
				</div>
				{person.role !== "" && (
					<div className="oc-role" title={person.role}>
						{person.role}
					</div>
				)}
				<div className="oc-stats" aria-hidden={!isSelected}>
					{directCount > 0
						? `${directCount} direct · ${totalCount} total`
						: reportSummary}
				</div>
			</div>
			{directCount > 0 && interactive && (
				<button
					type="button"
					className={
						isCollapsed
							? "oc-pill oc-interactive is-collapsed"
							: "oc-pill oc-interactive"
					}
					aria-expanded={!isCollapsed}
					aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${directCount} ${
						directCount === 1 ? "report" : "reports"
					} of ${person.name}`}
					tabIndex={ghost ? -1 : 0}
					onClick={(e) => {
						e.stopPropagation();
						onToggleId(id);
					}}
				>
					{directCount}
					<svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true">
						{isCollapsed ? (
							<path
								d="M2 3.5 5 6.5 8 3.5"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						) : (
							<path
								d="M2 6.5 5 3.5 8 6.5"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						)}
					</svg>
				</button>
			)}
		</div>
	);
});

// ---------------------------------------------------------------------------
// States: skeleton loading + unbound setup.

function SkeletonTree(): ReactNode {
	const w = CARD_W * 2 + 24;
	const h = CARD_H * 2 + RANK_GAP;
	const parent = { x: (w - CARD_W) / 2, y: 0, o: 1 };
	const left = { x: 0, y: CARD_H + RANK_GAP, o: 1 };
	const right = { x: CARD_W + 24, y: CARD_H + RANK_GAP, o: 1 };
	return (
		<div
			className="oc-viewport is-static"
			aria-label="Loading org chart"
			aria-busy="true"
		>
			<div className="oc-skeleton-stage" style={{ width: w, height: h }}>
				<svg className="oc-edges" width={1} height={1} aria-hidden="true">
					<path className="oc-edge" d={edgePath(parent, left)} />
					<path className="oc-edge" d={edgePath(parent, right)} />
				</svg>
				{[parent, left, right].map((p, i) => (
					<div
						key={i}
						className="oc-node"
						style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
					>
						<div className="oc-card oc-skeleton-card">
							<span className="oc-avatar oc-skeleton-block" />
							<span className="oc-skeleton-block oc-skeleton-line-lg" />
							<span className="oc-skeleton-block oc-skeleton-line-sm" />
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

function SetupState(): ReactNode {
	return (
		<div className="oc-setup-wrap">
			<div className="oc-setup-sample" aria-hidden="true">
				<ChartCanvas people={SAMPLE_PEOPLE} interactive={false} />
			</div>
			<div className="oc-setup-overlay">
				<div className="oc-setup-card" role="status">
					<div className="oc-setup-title">Set up your org chart</div>
					<p className="oc-setup-body">
						Map a People database with Name, Role, and a Reports to relation to
						see your org.
					</p>
				</div>
			</div>
		</div>
	);
}

function EmptyState(): ReactNode {
	return (
		<div className="oc-empty-wrap" role="status">
			<div className="oc-empty-mark" aria-hidden="true">
				0
			</div>
			<div className="oc-empty-title">No people yet</div>
			<p className="oc-empty-body">
				Add people to the mapped database to build your org chart.
			</p>
		</div>
	);
}

// ---------------------------------------------------------------------------

export function OrgChart({
	data,
	theme,
}: {
	data: OrgDataState;
	theme: "light" | "dark";
}): ReactNode {
	return (
		<div className="nds oc-root" data-display-mode={theme}>
			{data.status === "loading" ? (
				<SkeletonTree />
				) : data.status === "unbound" ? (
					<SetupState />
				) : data.status === "empty" ? (
					<EmptyState />
				) : (
				<ChartCanvas people={data.people} interactive />
			)}
		</div>
	);
}
