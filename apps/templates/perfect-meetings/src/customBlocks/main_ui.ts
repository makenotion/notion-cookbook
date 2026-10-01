import { customBlock } from "@notionhq/apps"

import { companies, meetings, people, syncRuns } from "../notion.js"

// The capability key, main_ui, comes from this file name; keep it stable.
// The name and slash command are display only.
const mainUi = customBlock({
  path: "./blocks/main_ui",
  name: "Perfect Meetings",
  description:
    "Sets up your calendar sync, then shows company and attendee cards for your current or next meeting, and a calendar of today's meetings.",
  slashCommand: "perfect-meetings",
  // runs (Workflow runs) drives the onboarding and progress states, and the
  // Sync calendar button adds a row there to start a catch-up.
  dataSources: { meetings, people, companies, runs: syncRuns },
})

// The view keeps its resource ID, which APP.md embeds.
meetings.addCustomView({
  resourceId: "meetings-next-view",
  name: "Today",
  customBlock: mainUi,
  dataSource: meetings.dataSource,
})

export default mainUi
