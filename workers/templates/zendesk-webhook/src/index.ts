import { Worker } from "@notionhq/workers"

import { registerZendeskToNotionWebhook } from "./webhook.js"

const worker = new Worker()
registerZendeskToNotionWebhook(worker)

export default worker
