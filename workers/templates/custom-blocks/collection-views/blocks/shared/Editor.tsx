import { useEffect, useRef, useState } from "react"
import type { NotionPagePropertyInputMap } from "@notionhq/custom-blocks"
import { stageProperty, titleProperty } from "./model"
import type { Item, Stage } from "./model"

type EditorProps = {
	item: Item | undefined
	stages: Stage[]
	stageType: "select" | "status"
	mapped: { [key: string]: string | undefined }
	pending: boolean
	error: string | undefined
	onSave: (properties: NotionPagePropertyInputMap) => Promise<boolean>
	onClose: () => void
}

export function Editor({
	item,
	stages,
	stageType,
	mapped,
	pending,
	error,
	onSave,
	onClose,
}: EditorProps) {
	const dialog = useRef<HTMLDialogElement>(null)
	const [name, setName] = useState(item?.name ?? "")
	const [stage, setStage] = useState(item?.stage ?? "")
	const [summary, setSummary] = useState(item?.summary ?? "")
	const [due, setDue] = useState(item?.due ?? "")
	const [rating, setRating] = useState(item?.rating?.toString() ?? "")
	useEffect(() => {
		dialog.current?.showModal()
	}, [])
	async function save() {
		const inputs = dialog.current?.querySelectorAll("input, textarea, select")
		if (inputs)
			for (const input of inputs) {
				if (input instanceof HTMLInputElement && !input.reportValidity()) return
			}
		if (!name.trim()) return
		const properties: NotionPagePropertyInputMap =
			!item || name.trim() !== item.name ? titleProperty(name.trim()) : {}
		if (mapped.stage && (!item || stage !== item.stage))
			Object.assign(properties, stageProperty(stage, stageType))
		if (mapped.summary && (!item || summary !== item.summary))
			properties.summary = {
				type: "rich_text",
				rich_text: [{ type: "text", text: { content: summary } }],
			}
		if (mapped.due && (!item || due !== item.due))
			properties.due = { type: "date", date: due ? { start: due } : null }
		if (mapped.rating && (!item || rating !== (item.rating?.toString() ?? "")))
			properties.rating = {
				type: "number",
				number: rating === "" ? null : Number(rating),
			}
		if (!Object.keys(properties).length || (await onSave(properties))) onClose()
	}
	return (
		<dialog
			ref={dialog}
			aria-labelledby="editor-title"
			onCancel={(event) => {
				if (pending) event.preventDefault()
				else onClose()
			}}
			onClose={onClose}
		>
			<div
				role="form"
				aria-label="Project properties"
				onKeyDown={(event) => {
					if (
						event.key === "Enter" &&
						event.target instanceof HTMLInputElement
					) {
						event.preventDefault()
						void save()
					}
				}}
			>
				<h2 id="editor-title">{item ? "Edit project" : "New project"}</h2>
				<label>
					Name
					<input
						autoFocus
						required
						maxLength={500}
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				{mapped.stage && (
					<label>
						Stage
						<select
							aria-label="Stage"
							value={stage}
							onChange={(event) => setStage(event.target.value)}
						>
							{stages.map((option) => (
								<option key={option.name} value={option.name}>
									{option.name || "No stage"}
								</option>
							))}
						</select>
					</label>
				)}
				{mapped.summary && (
					<label>
						Summary
						<textarea
							maxLength={2000}
							value={summary}
							onChange={(event) => setSummary(event.target.value)}
						/>
					</label>
				)}
				{mapped.due && (
					<label>
						Due date
						<input
							type="date"
							value={due}
							onChange={(event) => setDue(event.target.value)}
						/>
					</label>
				)}
				{mapped.rating && (
					<label>
						Rating
						<input
							type="number"
							min={0}
							max={5}
							step={1}
							value={rating}
							onChange={(event) => setRating(event.target.value)}
						/>
					</label>
				)}
				{error !== undefined && (
					<p className="error" role="alert">
						Couldn’t save: {error}
					</p>
				)}
				<div className="dialog-actions">
					<button type="button" disabled={pending} onClick={onClose}>
						Cancel
					</button>
					<button
						className="primary"
						data-bg-theme="blue"
						disabled={pending || !name.trim()}
						onClick={() => {
							void save()
						}}
					>
						Save project
					</button>
				</div>
			</div>
		</dialog>
	)
}
