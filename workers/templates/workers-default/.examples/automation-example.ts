/**
 * Automations are only available in a private alpha.
 */

import { Worker } from "@notionhq/workers"

const worker = new Worker()
export default worker

type RichTextProperty = {
  type: "rich_text"
  rich_text: Array<{ plain_text: string }>
}

/**
 * Example automation that sends an email based on a database page property.
 *
 * This automation:
 * 1. Reads an email address from a page property
 * 2. Sends an email to that address
 * 3. Updates the page to indicate the email has been sent
 */
worker.automation("sendEmailAutomation", {
  title: "Send Email Automation",
  description: "Reads an email address from a database page and sends an email",
  execute: async (event, { notion }) => {
    const { pageId, pageData } = event
    // Extract email from the page data
    const emailProperty = pageData?.properties?.Email as
      | RichTextProperty
      | undefined

    // Extract text content from the property
    let emailValue = ""
    if (emailProperty?.type === "rich_text") {
      emailValue = emailProperty.rich_text.map((rt) => rt.plain_text).join("")
    }

    // Handle empty email or pageId
    if (!emailValue || !pageId) {
      return
    }

    await sendEmail(emailValue)

    // Update the page to indicate the email has been sent
    await notion.pages.update({
      page_id: pageId,
      properties: {
        EmailSent: {
          checkbox: true,
        },
      },
    })
  },
})

async function sendEmail(email: string): Promise<void> {
  console.log(`Sending email to ${email}`)
}
