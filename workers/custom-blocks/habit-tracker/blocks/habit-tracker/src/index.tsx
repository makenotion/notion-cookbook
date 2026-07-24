import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NotionCustomBlock, useTheme } from "@notionhq/custom-blocks/react";
import "./nds.css";
import "./index.css";
import "./styles.css";
import { App } from "./App";
import { useMockStore } from "./mockStore";
import { useNotionStore } from "./notionStore";
import type { HabitStore, StoreStatus } from "./types";

const params = new URLSearchParams(window.location.search);
const isMock = params.has("mock");

function Shell({
	theme,
	fill,
	children,
}: {
	theme: "light" | "dark";
	fill?: boolean;
	children: React.ReactNode;
}) {
	return (
		<div
			className="nds ht-shell"
			data-display-mode={theme}
			style={fill ? { minHeight: "100vh" } : undefined}
		>
			{children}
		</div>
	);
}

/** Static store used for the pre-init loading and init-failure states. */
function staticStore(status: StoreStatus, detail?: string): HabitStore {
	return {
		status,
		unboundDetail: detail,
		habits: [],
		completed: new Set(),
		toggle: async () => false,
		createHabit: async () => false,
		lastError: null,
		clearError: () => undefined,
	};
}

function MockRoot() {
	const theme = params.get("theme") === "dark" ? "dark" : "light";
	const store = useMockStore({
		empty: params.has("empty"),
		failWrites: params.has("failwrites"),
		many: params.has("many"),
	});
	let effective: HabitStore = store;
	if (params.has("unbound")) effective = { ...store, status: "unbound" };
	else if (params.has("loading")) effective = { ...store, status: "loading" };
	return (
		<Shell theme={theme} fill>
			<App store={effective} />
		</Shell>
	);
}

function NotionInner() {
	const theme = useTheme();
	const store = useNotionStore();
	return (
		<Shell theme={theme}>
			<App store={store} />
		</Shell>
	);
}

function prefersDark(): boolean {
	return Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches);
}

function NotionRoot() {
	const fallbackTheme = prefersDark() ? "dark" : "light";
	return (
		<NotionCustomBlock
			autoResize
			fallback={
				<Shell theme={fallbackTheme}>
					<App store={staticStore("loading")} />
				</Shell>
			}
			errorFallback={(error) => (
				<Shell theme={fallbackTheme}>
					<App store={staticStore("unbound", error.message)} />
				</Shell>
			)}
		>
			<NotionInner />
		</NotionCustomBlock>
	);
}

const rootEl = document.getElementById("root");
if (rootEl) {
	createRoot(rootEl).render(
		<StrictMode>{isMock ? <MockRoot /> : <NotionRoot />}</StrictMode>,
	);
}
