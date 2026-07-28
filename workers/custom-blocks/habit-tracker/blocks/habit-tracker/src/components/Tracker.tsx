import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	addMonths,
	compareMonthToDate,
	currentStreak,
	daysInMonth,
	isWeekend,
	MONTH_NAMES,
	monthOf,
	todayYmd,
	ymdOf,
} from "../dates";
import type { MonthRef, Streak } from "../dates";
import type { Habit, HabitStore } from "../types";
import { cellKey } from "../types";

/** Per-habit color slots, resolved from the NDS ramps. */
function habitStyle(color: Habit["color"]): CSSProperties {
	return {
		"--h-fill": `var(--translucent-${color}-80)`,
		"--h-glyph": `var(--${color}-140)`,
		"--h-soft": `var(--translucent-${color}-30)`,
	} as CSSProperties;
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

function CheckIcon() {
	return (
		<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false">
			<path
				d="M2.5 6.4 L5 8.8 L9.5 3.4"
				fill="none"
				stroke="var(--h-glyph)"
				strokeWidth="1.8"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function Chevron({ direction }: { direction: "left" | "right" }) {
	const d = direction === "left" ? "M10 3.5 L5.5 8 L10 12.5" : "M6 3.5 L10.5 8 L6 12.5";
	return (
		<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
			<path
				d={d}
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function Ring({ pct, label }: { pct: number; label: string }) {
	const size = 18;
	const sw = 2.5;
	const r = (size - sw) / 2;
	const circ = 2 * Math.PI * r;
	const filled = (clamp(pct, 0, 100) / 100) * circ;
	return (
		<svg
			width={size}
			height={size}
			viewBox={`0 0 ${size} ${size}`}
			role="img"
			aria-label={label}
			className="ht-ringsvg"
		>
			<circle
				cx={size / 2}
				cy={size / 2}
				r={r}
				fill="none"
				stroke="var(--border-secondary)"
				strokeWidth={sw}
			/>
			{filled > 0 ? (
				<circle
					cx={size / 2}
					cy={size / 2}
					r={r}
					fill="none"
					stroke="var(--bg-interactive-strong)"
					strokeWidth={sw}
					strokeDasharray={`${filled} ${circ}`}
					strokeLinecap="round"
					transform={`rotate(-90 ${size / 2} ${size / 2})`}
				/>
			) : null}
		</svg>
	);
}

type CellProps = {
	ariaLabel: string;
	done: boolean;
	disabled: boolean;
	pending: boolean;
	todayCol: boolean;
	lastRow: boolean;
	tabIndex: number;
	onToggle: () => void;
	onFocusCell: () => void;
	cellRef: (el: HTMLButtonElement | null) => void;
};

function Cell(props: CellProps) {
	// Nonce so the fill-in animation runs only on user toggles, never on load.
	const [fillNonce, setFillNonce] = useState(0);
	const handleClick = () => {
		if (props.disabled) return;
		if (!props.done) setFillNonce((n) => n + 1);
		props.onToggle();
	};
	const cls =
		"ht-cell" + (props.todayCol ? " ht-todayband" : "") + (props.lastRow ? " ht-lastrow" : "");
	const dotCls =
		"ht-dot" +
		(props.done ? " ht-dot-done" : "") +
		(props.done && fillNonce > 0 ? " ht-dot-fill" : "");
	return (
		<button
			type="button"
			className={cls}
			aria-label={props.ariaLabel}
			aria-pressed={props.done}
			aria-disabled={props.disabled || undefined}
			aria-busy={props.pending || undefined}
			tabIndex={props.tabIndex}
			ref={props.cellRef}
			onClick={handleClick}
			onFocus={props.onFocusCell}
		>
			<span key={fillNonce} className={dotCls}>
				{props.done ? <CheckIcon /> : null}
			</span>
		</button>
	);
}

function NewHabitRow({
	onCreate,
	autoOpen,
}: {
	onCreate: (name: string) => Promise<boolean>;
	autoOpen?: boolean;
}) {
	const [editing, setEditing] = useState(Boolean(autoOpen));
	const [value, setValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (editing) inputRef.current?.focus();
	}, [editing]);

	const submit = () => {
		const name = value.trim();
		if (!name) return;
		// The stores add an optimistic row (and revert on failure), so the
		// editor can close immediately.
		void onCreate(name);
		setValue("");
		setEditing(false);
	};

	if (!editing) {
		return (
			<button type="button" className="ht-newhabit" onClick={() => setEditing(true)}>
				<span className="ht-plus" aria-hidden="true">
					＋
				</span>
				New habit
			</button>
		);
	}

	return (
		<span className="ht-newhabit-edit">
			<input
				ref={inputRef}
				className="ht-newhabit-input"
				type="text"
				placeholder="Habit name"
				aria-label="New habit name"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") submit();
					if (e.key === "Escape") {
						setValue("");
						setEditing(false);
					}
				}}
				onBlur={() => {
					if (value.trim()) submit();
					else setEditing(false);
				}}
			/>
			<span className="ht-newhabit-hint">Enter to add · Esc to cancel</span>
		</span>
	);
}

export function SetupCard({ detail }: { detail?: string }) {
	return (
		<div className="ht-setup">
			<div className="ht-setup-card" role="status">
				<div className="ht-setup-title">Set up your habit tracker</div>
				<p className="ht-setup-body">
					Map a <strong>Habits</strong> database and a <strong>Habits Log</strong> database to start
					tracking.
				</p>
				{detail ? <p className="ht-setup-detail">{detail}</p> : null}
			</div>
		</div>
	);
}

export function SkeletonView() {
	return (
		<div className="ht-root" role="status" aria-label="Loading habit tracker">
			<div aria-hidden="true">
			<div className="ht-header">
				<span className="ht-skel" style={{ width: 120, height: 20 }} />
				<span className="ht-controls">
					<span className="ht-skel" style={{ width: 110, height: 18 }} />
				</span>
			</div>
			{[92, 74, 84, 66].map((w, i) => (
				<div className="ht-skel-row" key={i}>
					<span className="ht-skel" style={{ width: w, height: 14 }} />
					<span className="ht-skel ht-skel-grow" style={{ height: 14 }} />
				</div>
			))}
		</div>
		</div>
	);
}

export function Tracker({ store, readOnly }: { store: HabitStore; readOnly?: boolean }) {
	const today = todayYmd();
	const todayMonth = monthOf(today);
	const todayDay = Number(today.slice(8, 10));
	const [view, setView] = useState<MonthRef>(todayMonth);
	const { habits, completed } = store;

	const monthKind = compareMonthToDate(view, today); // -1 past, 0 current, 1 future
	const dayCount = daysInMonth(view.year, view.month);
	/** Last day of the viewed month that can be toggled / counted. */
	const doneThrough = monthKind < 0 ? dayCount : monthKind === 0 ? todayDay : 0;

	const [focusPos, setFocusPos] = useState({ r: 0, c: todayDay - 1 });
	const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
	const pendingKeysRef = useRef(new Set<string>());
	const cellRefs = useRef(new Map<string, HTMLButtonElement>());
	const scrollRef = useRef<HTMLDivElement>(null);
	const todayHeadRef = useRef<HTMLDivElement>(null);

	// Streaks always anchor at the real today, regardless of the viewed month.
	// They count back across month boundaries; if the loaded log window is
	// truncated, the streak is capped and rendered as "n+".
	const streaks = useMemo(() => {
		const map = new Map<string, Streak>();
		for (const h of habits) {
			map.set(
				h.id,
				currentStreak((d) => completed.has(cellKey(h.id, d)), today, store.logWindowStart)
			);
		}
		return map;
	}, [habits, completed, today, store.logWindowStart]);

	const monthCounts = useMemo(() => {
		const map = new Map<string, number>();
		for (const h of habits) {
			let n = 0;
			for (let d = 1; d <= doneThrough; d++) {
				if (completed.has(cellKey(h.id, ymdOf(view.year, view.month, d)))) n++;
			}
			map.set(h.id, n);
		}
		return map;
	}, [habits, completed, view.year, view.month, doneThrough]);

	const perfectDays = useMemo(() => {
		const set = new Set<number>();
		if (habits.length === 0) return set;
		for (let d = 1; d <= doneThrough; d++) {
			const date = ymdOf(view.year, view.month, d);
			if (habits.every((h) => completed.has(cellKey(h.id, date)))) set.add(d);
		}
		return set;
	}, [habits, completed, view.year, view.month, doneThrough]);

	const totalDone = useMemo(() => {
		let n = 0;
		for (const v of monthCounts.values()) n += v;
		return n;
	}, [monthCounts]);
	const totalPossible = habits.length * doneThrough;
	const pct = totalPossible === 0 ? 0 : Math.round((totalDone / totalPossible) * 100);

	// Keep the keyboard cursor inside the grid when the month or rows change.
	useEffect(() => {
		setFocusPos((prev) => ({
			r: clamp(prev.r, 0, Math.max(0, habits.length - 1)),
			c: clamp(prev.c, 0, dayCount - 1),
		}));
	}, [habits.length, dayCount]);

	// Auto-scroll so today's column is visible.
	useEffect(() => {
		const scroller = scrollRef.current;
		const target = todayHeadRef.current;
		if (!scroller || !target) return;
		const rightEdge = target.offsetLeft + target.offsetWidth;
		const usable = scroller.clientWidth - 56; // room for the sticky count column
		if (rightEdge > scroller.scrollLeft + usable) {
			scroller.scrollLeft = Math.max(0, rightEdge - usable + 8);
		}
	}, [view.year, view.month, habits.length, monthKind]);

	// Track whether content is scrolled under the sticky columns (hairline edges).
	useEffect(() => {
		const scroller = scrollRef.current;
		if (!scroller) return;
		const update = () => {
			scroller.dataset.overflowLeft = String(scroller.scrollLeft > 1);
			scroller.dataset.overflowRight = String(
				scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1
			);
		};
		update();
		scroller.addEventListener("scroll", update, { passive: true });
		const ro = new ResizeObserver(update);
		ro.observe(scroller);
		return () => {
			scroller.removeEventListener("scroll", update);
			ro.disconnect();
		};
	}, [habits.length, view.year, view.month]);

	// Quiet inline errors fade away on their own.
	useEffect(() => {
		if (!store.lastError) return;
		const t = setTimeout(() => store.clearError(), 4000);
		return () => clearTimeout(t);
	}, [store.lastError, store.clearError]);

	const handleToggle = useCallback(
		(habit: Habit, date: string) => {
			if (readOnly || habit.pending) return;
			const key = cellKey(habit.id, date);
			if (pendingKeysRef.current.has(key)) return;
			pendingKeysRef.current.add(key);
			setPendingKeys((prev) => new Set(prev).add(key));
			void store.toggle(habit.id, date, !completed.has(key)).finally(() => {
				pendingKeysRef.current.delete(key);
				setPendingKeys((prev) => {
					const next = new Set(prev);
					next.delete(key);
					return next;
				});
			});
		},
		[readOnly, completed, store]
	);

	const onGridKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		let dr = 0;
		let dc = 0;
		if (e.key === "ArrowRight") dc = 1;
		else if (e.key === "ArrowLeft") dc = -1;
		else if (e.key === "ArrowUp") dr = -1;
		else if (e.key === "ArrowDown") dr = 1;
		else if (e.key === "Home") dc = -focusPos.c;
		else if (e.key === "End") dc = dayCount - 1 - focusPos.c;
		else return;
		e.preventDefault();
		const r = clamp(focusPos.r + dr, 0, Math.max(0, habits.length - 1));
		const c = clamp(focusPos.c + dc, 0, dayCount - 1);
		setFocusPos({ r, c });
			cellRefs.current.get(`${r}:${c}`)?.focus();
	};

	const monthLabel = `${MONTH_NAMES[view.month]} ${view.year}`;
	const isCurrentMonth = monthKind === 0;

	const days: number[] = [];
	for (let d = 1; d <= dayCount; d++) days.push(d);

	const gridTemplate = `minmax(140px, 184px) repeat(${dayCount}, minmax(24px, 1fr)) minmax(44px, 52px)`;

	let body: ReactNode;
	if (habits.length === 0) {
		body = (
			<div className="ht-empty">
				<div className="ht-empty-title">Track your first habit</div>
				<p className="ht-empty-sub">
					Each habit becomes a row, each day a dot — check off the days you follow through.
				</p>
				{!readOnly ? <NewHabitRow onCreate={store.createHabit} autoOpen /> : null}
				{store.lastError ? (
					<span className="ht-error" role="alert">
						{store.lastError}
					</span>
				) : null}
			</div>
		);
	} else {
		body = (
				<div
				className="ht-scroll"
				ref={scrollRef}
				onKeyDown={onGridKeyDown}
				role="region"
				aria-label={`Habit tracker for ${monthLabel}. Use arrow keys, Home, and End to move between days.`}
				>
				<div className="ht-grid" style={{ gridTemplateColumns: gridTemplate }}>
					<div className="ht-corner ht-headrow" />
					{days.map((d) => {
						const isToday = isCurrentMonth && d === todayDay;
						const perfect = perfectDays.has(d);
						const numCls =
							"ht-daynum" +
							(isWeekend(view.year, view.month, d) ? " ht-weekend" : "") +
							(isToday ? " ht-daynum-today" : "") +
							(perfect ? " ht-daynum-perfect" : "");
						return (
							<div
								key={d}
								className={"ht-dayhead ht-headrow" + (isToday ? " ht-todayband" : "")}
								ref={isToday ? todayHeadRef : undefined}
								title={`${MONTH_NAMES[view.month]} ${d}, ${view.year}`}
							>
								<span className={numCls} aria-current={isToday ? "date" : undefined}>
									{d}
								</span>
							</div>
						);
					})}
					<div className="ht-corner ht-corner-right ht-headrow" />

					{habits.map((h, r) => {
						const streak = streaks.get(h.id) ?? { count: 0, capped: false };
						const streakLabel = `${streak.count}${streak.capped ? "+" : ""}`;
						const count = monthCounts.get(h.id) ?? 0;
						const lastRow = r === habits.length - 1;
						return (
							<Fragment key={h.id}>
								<div
									className={"ht-label" + (h.pending ? " ht-label-pending" : "")}
									style={habitStyle(h.color)}
								>
									<span className="ht-emoji" aria-hidden="true">
										{h.icon ? h.icon : <span className="ht-emoji-dot" />}
									</span>
									<span className="ht-name" title={h.name}>
										{h.name}
									</span>
									{streak.count >= 2 ? (
										<span
											className="ht-streak"
											title={`${streakLabel}-day streak`}
											aria-label={`${streakLabel}-day streak`}
										>
											🔥 {streakLabel}
										</span>
									) : null}
								</div>
								{days.map((d, c) => {
									const date = ymdOf(view.year, view.month, d);
									const key = cellKey(h.id, date);
									const done = completed.has(key);
									const future = monthKind > 0 || (isCurrentMonth && d > todayDay);
									const isToday = isCurrentMonth && d === todayDay;
									const pending = pendingKeys.has(key);
									const refKey = `${r}:${c}`;
									return (
										<span key={d} style={habitStyle(h.color)} className="ht-cellwrap">
											<Cell
												ariaLabel={`${h.name}, ${MONTH_NAMES[view.month]} ${d}${done ? ", completed" : ""}`}
												done={done}
												disabled={future || Boolean(readOnly) || Boolean(h.pending) || pending}
												pending={pending}
												todayCol={isToday}
												lastRow={lastRow}
												tabIndex={focusPos.r === r && focusPos.c === c ? 0 : -1}
												onToggle={() => handleToggle(h, date)}
												onFocusCell={() => setFocusPos({ r, c })}
												cellRef={(el) => {
													if (el) cellRefs.current.set(refKey, el);
													else cellRefs.current.delete(refKey);
												}}
											/>
										</span>
									);
								})}
								<div className={"ht-count" + (doneThrough === 0 ? " ht-count-dim" : "")}>
									{doneThrough === 0 ? "–" : `${count}/${doneThrough}`}
								</div>
							</Fragment>
						);
					})}
				</div>
			</div>
		);
	}

	return (
		<div className="ht-root">
			<div className="ht-header">
				<h2 className="ht-month" aria-live="polite">
					{monthLabel}
				</h2>
				<div className="ht-controls" role="group" aria-label="Month navigation">
					<button
						type="button"
						className="ht-iconbtn"
						aria-label="Previous month"
						onClick={() => setView((v) => addMonths(v, -1))}
					>
						<Chevron direction="left" />
					</button>
					<button
						type="button"
						className="ht-textbtn"
						disabled={isCurrentMonth}
						onClick={() => setView(todayMonth)}
					>
						Today
					</button>
					<button
						type="button"
						className="ht-iconbtn"
						aria-label="Next month"
						onClick={() => setView((v) => addMonths(v, 1))}
					>
						<Chevron direction="right" />
					</button>
					<div
						className="ht-progress"
						title={`${totalDone} of ${totalPossible} habit-days so far this month`}
					>
						<span>{pct}%</span>
						<Ring pct={pct} label={`${pct}% of habit-days completed in ${monthLabel}`} />
					</div>
				</div>
			</div>
			{body}
			{habits.length > 0 ? (
				<div className="ht-footer">
					{!readOnly ? <NewHabitRow onCreate={store.createHabit} /> : <span />}
					{store.lastError ? (
						<span className="ht-error" role="alert">
							{store.lastError}
						</span>
					) : null}
				</div>
			) : null}
		</div>
	);
}
