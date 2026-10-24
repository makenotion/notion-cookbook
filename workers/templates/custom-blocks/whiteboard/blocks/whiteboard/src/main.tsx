import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CustomBlockInitializationError } from "@notionhq/custom-blocks";
import { NotionCustomBlock, useTheme } from "@notionhq/custom-blocks/react";
import "./nds.css";
import "./index.css";
import { Whiteboard, WhiteboardSetup } from "./App";
import { useMockStore } from "./mockStore";
import { useNotionStore } from "./notionStore";
import { WHITEBOARD_SCHEMA_GUIDE } from "./schema";

const params = new URLSearchParams(window.location.search);
// Dev harness: render standalone with an in-memory store when not hosted
// inside Notion (?mock=1) or when running as a top-level tab.
const isMock = params.has("mock") || window.parent === window;

function MockRoot() {
	const theme = params.get("theme") === "dark" ? "dark" : "light";
	const store = useMockStore();
	return (
		<div className="nds" data-display-mode={theme}>
			<Whiteboard store={store} />
		</div>
	);
}

function NotionApp() {
	const theme = useTheme();
	const store = useNotionStore();
	return (
		<div className="nds" data-display-mode={theme}>
			<Whiteboard store={store} />
		</div>
	);
}

function InitErrorFallback({ error }: { error: Error }) {
	const isBindingError =
		error instanceof CustomBlockInitializationError &&
		[
			"missing_data_source_binding",
			"missing_property_binding",
			"invalid_property_binding",
			"invalid_init_bindings",
		].includes(error.code);

	if (!isBindingError) {
		return (
			<div className="nds">
				<WhiteboardSetup
					title="Couldn’t open the whiteboard"
					body={error.message}
				/>
			</div>
		);
	}

	return (
		<div className="nds">
			<WhiteboardSetup
				title="Fix the whiteboard database"
				body="Open this block’s settings and map every field to the property type shown below."
				issues={WHITEBOARD_SCHEMA_GUIDE.map(({ label, detail }) => ({
					property: label,
					message: detail,
				}))}
			/>
		</div>
	);
}

const root = createRoot(document.getElementById("root")!);
root.render(
	<StrictMode>
		{isMock ? (
			<MockRoot />
		) : (
			<NotionCustomBlock
				errorFallback={(error) => <InitErrorFallback error={error} />}
			>
				<NotionApp />
			</NotionCustomBlock>
		)}
	</StrictMode>,
);
