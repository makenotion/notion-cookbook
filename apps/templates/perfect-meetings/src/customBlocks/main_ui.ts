import { customBlock } from "@notionhq/apps"

import { companies, meetings, people, syncRuns } from "../notion.js"

const nextMeeting = customBlock({
  path: "./blocks/main_ui",
  name: "Next meeting",
  description:
    "Company and attendee cards for your current or next meeting, and a calendar of today's meetings.",
  slashCommand: "next-meeting",
  // runs (Workflow runs) drives the onboarding and progress states, and the
  // Sync calendar button adds a row there to start a catch-up.
  dataSources: { meetings, people, companies, runs: syncRuns },
})

meetings.addCustomView({
  resourceId: "meetings-next-view",
  name: "Next meeting",
  customBlock: nextMeeting,
  dataSource: meetings.dataSource,
})

export default nextMeeting
