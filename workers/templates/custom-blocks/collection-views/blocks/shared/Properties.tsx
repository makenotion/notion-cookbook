import { useEffect, useRef, useState } from "react"
import type { ItemActions } from "./Collection"
import type { Item, StageTheme } from "./model"
import { Icon } from "./Icons"

type ItemProps = { item: Item; actions: ItemActions }
export function ItemTitle({ item, actions }: ItemProps) {
	return (
		<button
			className="item-title"
			disabled={actions.pending}
			onClick={() => actions.open(item)}
			title={`Open ${item.name}`}
		>
			<Icon name="page" size={20} />
			<span>{item.name}</span>
		</button>
	)
}
type StageChipProps = { name: string; colors: ReadonlyMap<string, StageTheme> }
export function StageChip({ name, colors }: StageChipProps) {
	if (!name) return undefined
	const color = colors.get(name) ?? "gray"
	return (
		<span className="chip" data-bg-theme={color} data-content-theme={color}>
			{name}
		</span>
	)
}
export function ItemMeta({ item, actions }: ItemProps) {
	return (
		<div className="item-meta">
			<StageChip name={item.stage} colors={actions.stageColors} />
			<DueDate value={item.due} />
			<Owners ids={item.owners} names={actions.owners} />
			<Rating value={item.rating} />
		</div>
	)
}
type OwnersProps = { ids: string[]; names: ReadonlyMap<string, string> }
export function Owners({ ids, names }: OwnersProps) {
	return (
		<span className="owners">
			{ids.map((id) => {
				const label = names.get(id) ?? `Person ${id.slice(0, 8)}`
				return (
					<span key={id} title={label}>
						<span className="avatar" aria-hidden="true">
							{label.slice(0, 1)}
						</span>
						{label}
					</span>
				)
			})}
		</span>
	)
}
type DueDateProps = { value: string }
export function DueDate({ value }: DueDateProps) {
	if (!value) return undefined
	const date = new Date(`${value}T12:00:00`)
	return (
		<time dateTime={value}>
			{Number.isNaN(date.getTime())
				? value
				: new Intl.DateTimeFormat("en-US", {
						month: "long",
						day: "numeric",
						year: "numeric",
					}).format(date)}
		</time>
	)
}
type RatingProps = { value: number | undefined }
export function Rating({ value }: RatingProps) {
	return value === undefined ? undefined : (
		<span className="rating">{value}</span>
	)
}

export function ItemButtons({ item, actions }: ItemProps) {
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
			className="row-menu"
			onKeyDown={(event) => {
				if (event.key === "Escape" && ref.current) {
					ref.current.open = false
					ref.current.querySelector("summary")?.focus()
				}
			}}
		>
			<summary
				className="icon-button"
				aria-label={`Actions for ${item.name}`}
				title="Actions"
			>
				<Icon name="more" />
			</summary>
			<div className="row-menu-panel">
				<button
					disabled={actions.pending}
					onClick={() => {
						if (ref.current) ref.current.open = false
						actions.edit(item)
					}}
					aria-label={`Edit ${item.name}`}
				>
					<Icon name="edit" />
					Edit properties
				</button>
				<button disabled={actions.pending} onClick={() => actions.open(item)}>
					<Icon name="open" />
					Open page
				</button>
				<label>
					Move to
					<select
						aria-label={`Move ${item.name} to`}
						disabled={actions.pending}
						value={item.stage}
						onChange={(event) => actions.move(item, event.target.value)}
					>
						{actions.stages.map((stage) => (
							<option key={stage} value={stage}>
								{stage || "No stage"}
							</option>
						))}
					</select>
				</label>
			</div>
		</details>
	)
}

type CoverProps = { item: Item }
export function Cover({ item }: CoverProps) {
	const [url, setUrl] = useState<string>()
	const [loading, setLoading] = useState(Boolean(item.loadImage))
	const [error, setError] = useState<string>()
	const [retry, setRetry] = useState(0)
	useEffect(() => {
		let active = true
		setError(undefined)
		setUrl(undefined)
		setLoading(Boolean(item.loadImage))
		if (item.loadImage)
			void item
				.loadImage(retry > 0)
				.then((value) => {
					if (active) {
						setUrl(value)
						setLoading(false)
					}
				})
				.catch((reason: unknown) => {
					if (active)
						setError(
							reason instanceof Error ? reason.message : "Image unavailable"
						)
				})
		return () => {
			active = false
		}
	}, [item.loadImage, retry])
	if (error)
		return (
			<div className="cover image-error">
				<span>Image unavailable</span>
				<button
					title={error}
					onClick={() => setRetry((current) => current + 1)}
				>
					Retry image
				</button>
			</div>
		)
	return url ? (
		<img
			className="cover"
			src={url}
			alt=""
			loading="lazy"
			referrerPolicy="no-referrer"
			onError={() =>
				setError("The image could not be loaded. Its URL may have expired.")
			}
		/>
	) : (
		<div
			className="cover"
			aria-label={loading ? "Loading image" : "No image"}
		/>
	)
}
export function PageBodyPlaceholder() {
	return (
		<div className="body-placeholder">
			<p>Page content preview</p>
			<span>Open the page to read its content.</span>
		</div>
	)
}

type RelativeDateProps = { value: string | undefined }
export function RelativeDate({ value }: RelativeDateProps) {
	if (!value) return undefined
	const date = new Date(value)
	if (!Number.isFinite(date.getTime())) return undefined
	const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000))
	let label: string
	if (minutes < 1) label = "now"
	else if (minutes < 60) label = `${minutes}m`
	else if (minutes < 1440) label = `${Math.floor(minutes / 60)}h`
	else if (minutes < 10080) label = `${Math.floor(minutes / 1440)}d`
	else
		label = new Intl.DateTimeFormat("en-US", {
			month: "short",
			day: "numeric",
		}).format(date)
	return (
		<time dateTime={value} title={date.toLocaleString()} className="muted">
			{label}
		</time>
	)
}
