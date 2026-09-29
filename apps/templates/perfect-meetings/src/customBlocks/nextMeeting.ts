import { customBlock } from "@notionhq/apps"

import { companies, meetings, people } from "../notion.js"

const nextMeeting = customBlock({
  path: "./blocks/nextMeeting",
  name: "Next meeting",
  description:
    "Company and attendee cards for your current or next meeting, and a calendar of today's meetings.",
  slashCommand: "next-meeting",
  dataSources: { meetings, people, companies },
})

meetings.addCustomView({
  resourceId: "meetings-next-view",
  name: "Next meeting",
  customBlock: nextMeeting,
  dataSource: meetings.dataSource,
})

export default nextMeeting
