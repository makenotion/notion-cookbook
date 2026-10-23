import { createRoot } from "react-dom/client"
import {
	NotionCustomBlock,
	NotionTokenScope,
} from "@notionhq/custom-blocks/react"
import "@notionhq/custom-blocks/nds.css"
import "./styles.css"
import { Collection } from "./Collection"
import { useNotionSource } from "./source"
import type { View } from "./model"

export function mount(view: View) {
	const root = document.getElementById("root")
	if (!root) throw new Error("Missing root element")
	if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
		void import("./preview").then(({ mountPreview }) =>
			mountPreview(root, view)
		)
		return
	}
	createRoot(root).render(
		<NotionCustomBlock
			fallback={
				<p className="initial-state" role="status">
					Connecting to Notion… Bind Projects in the host’s Data settings.
				</p>
			}
			errorFallback={(error) => (
				<div className="initial-state" role="alert">
					<h1>Connect Projects</h1>
					<p>{error.message}</p>
					<p>
						Map the Projects data source and its properties in the host, then
						retry.
					</p>
					<button onClick={() => location.reload()}>Retry connection</button>
				</div>
			)}
		>
			<NotionTokenScope>
				<Collection view={view} useSource={useNotionSource} />
			</NotionTokenScope>
		</NotionCustomBlock>
	)
}
