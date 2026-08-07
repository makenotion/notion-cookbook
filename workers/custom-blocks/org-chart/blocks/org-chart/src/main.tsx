import { createRoot } from "react-dom/client";
import { NotionCustomBlock, useTheme } from "@notionhq/custom-blocks/react";
import { OrgChart } from "./OrgChart";
import { MOCK_PEOPLE } from "./mockData";
import { useNotionPeople } from "./useNotionPeople";
import type { OrgDataState } from "./types";
import "./nds.css";
import "./index.css";
import "./orgchart.css";

const params = new URLSearchParams(window.location.search);
const isMock = params.has("mock");

/** Standalone dev harness: in-memory data, theme via ?theme=dark. */
function MockRoot(): React.ReactNode {
	const theme = params.get("theme") === "dark" ? "dark" : "light";
	const scenario = params.get("scenario");
	let data: OrgDataState;
	if (scenario === "loading") {
		data = { status: "loading" };
	} else if (scenario === "empty") {
		data = { status: "empty" };
	} else if (scenario === "unbound") {
		data = { status: "unbound" };
	} else if (scenario === "single") {
		data = { status: "ready", people: [{ ...MOCK_PEOPLE[0], managerIds: [] }] };
	} else if (scenario === "cycle") {
		// Degenerate data: a 2-cycle, a self-reference, a dangling manager
		// pointer, a missing role, and duplicate names.
		data = {
			status: "ready",
			people: [
				{ id: "c-1", name: "Ava Cycle", role: "A → B", managerIds: ["c-2"] },
				{ id: "c-2", name: "Bo Cycle", role: "B → A", managerIds: ["c-1"] },
				{ id: "c-3", name: "Sol Self", role: "Reports to self", managerIds: ["c-3"] },
				{ id: "c-4", name: "Dana Dangling", role: "", managerIds: ["gone-1"] },
				{ id: "c-5", name: "Alex Kim", role: "Engineer", managerIds: ["c-4"] },
				{ id: "c-6", name: "Alex Kim", role: "Engineer", managerIds: ["c-4"] },
				{
					id: "c-7",
					name: "Wolfeschlegelsteinhausenbergerdorff von Knacker III",
					role: "Principal Staff Software Architect, Platform Infrastructure",
					managerIds: ["c-4"],
				},
			],
		};
	} else if (scenario === "big") {
		// ~121 people: one root with 20 direct reports, each with 5 reports.
		const people = [
			{ id: "b-root", name: "Robin Root", role: "CEO", managerIds: [] as string[] },
		];
		for (let m = 0; m < 20; m++) {
			people.push({
				id: `b-m${m}`,
				name: `Manager ${m + 1}`,
				role: "Team Lead",
				managerIds: ["b-root"],
			});
			for (let r = 0; r < 5; r++) {
				people.push({
					id: `b-m${m}-r${r}`,
					name: `Person ${m + 1}.${r + 1}`,
					role: "Contributor",
					managerIds: [`b-m${m}`],
				});
			}
		}
		data = { status: "ready", people };
	} else {
		data = { status: "ready", people: MOCK_PEOPLE };
	}
	return <OrgChart data={data} theme={theme} />;
}

function HostedApp(): React.ReactNode {
	const theme = useTheme();
	const data = useNotionPeople();
	return <OrgChart data={data} theme={theme} />;
}

const root = createRoot(document.getElementById("root")!);
root.render(
	isMock ? (
		<MockRoot />
	) : (
		<NotionCustomBlock autoResize={false}>
			<HostedApp />
		</NotionCustomBlock>
	),
);
