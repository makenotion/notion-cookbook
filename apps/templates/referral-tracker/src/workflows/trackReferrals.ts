import { access, events, workflow } from "@notionhq/apps"

import inbox from "../connections/inbox.js"
import { referrals } from "../notion.js"
import {
  findCandidateEmail,
  REFERRAL_PATTERN,
  REFERRAL_QUERY,
  threadKey,
  threadMarkdown,
  type MailMessage,
} from "./lib/referral.js"

// New-email runs only search recent mail. Threads already in Referrals are
// skipped, so overlapping runs do not add duplicates.
const RECENT = "newer_than:2d"
const PAGE_SIZE = 100

type MailResult = {
  content: unknown
  structuredContent?: unknown
  isError?: boolean
}

// Mail returns JSON in structuredContent, or as text in the first content item.
function readMail<T>(result: MailResult, action: string): T {
  if (result.isError) {
    throw new Error(`Mail could not ${action}`)
  }
  if (result.structuredContent) {
    return result.structuredContent as T
  }
  const [first] = result.content as Array<{ text?: string }>
  return JSON.parse(first?.text ?? "{}") as T
}

export default workflow({
  name: "Track referrals",
  description:
    "Adds a Referrals row for each email that mentions a referral or resume. Run it by hand to add past emails.",
  triggers: [
    events.mailEmailReceived({ accounts: inbox.referrals }),
    // Backfill: searches all mail. Threads already in Referrals are skipped.
    events.manual(),
  ],
  access: { referrals: access.edit(referrals.dataSource) },
  handler: async (event, context) => {
    if (
      event.type === "mail.email.received" &&
      !REFERRAL_PATTERN.test(`${event.email.subject}\n${event.email.body}`)
    ) {
      return
    }
    const query =
      event.type === "workflow.manual"
        ? REFERRAL_QUERY
        : `(${REFERRAL_QUERY}) ${RECENT}`

    const mailbox = await context.step("Find mailbox", async () => {
      const [account] = await inbox.listAccounts({ accounts: inbox.referrals })
      if (!account) {
        throw new Error("Pick a mailbox for referrals in App setup")
      }
      return account.email
    })

    let pageToken: string | undefined
    let page = 0
    do {
      const search = await context.step(`Search mail ${page}`, async () => {
        const result = readMail<{
          threads: Array<{ threadId: string }>
          pageInfo?: { cursor?: string }
        }>(
          await inbox.searchEmails({
            account: inbox.referrals,
            query,
            count: PAGE_SIZE,
            pageToken,
          }),
          "search"
        )
        return {
          threadIds: result.threads.map(({ threadId }) => threadId),
          cursor: result.pageInfo?.cursor || undefined,
        }
      })

      for (const threadId of search.threadIds) {
        const key = threadKey(threadId)
        const exists = await context.step(`Check ${key}`, async () => {
          const { results } = await context.notion.dataSources.query({
            data_source_id: context.access.referrals.id,
            filter: { property: "Thread ID", rich_text: { equals: key } },
            page_size: 1,
          })
          return results.length > 0
        })
        if (exists) {
          continue
        }

        const thread = await context.step(`Read ${key}`, async () =>
          readMail<{ url?: string; messages: MailMessage[] }>(
            await inbox.viewThreadContent({
              account: inbox.referrals,
              threadId,
              mostRecentMessageOnly: false,
            }),
            "read the thread"
          )
        )
        const [first] = thread.messages
        if (!first) {
          continue
        }

        // Copy each attachment into Notion. Mail cannot read attachments over
        // about 3 MB; those are left out and the row is still added.
        const files: Array<{ id: string; name: string }> = []
        for (const message of thread.messages) {
          for (const attachment of message.attachments ?? []) {
            if (attachment.inline) {
              continue
            }
            const id = await context.step(
              `Upload ${key} ${attachment.attachmentId}`,
              async () => {
                const result = await inbox.readAttachment({
                  account: inbox.referrals,
                  messageId: message.messageId,
                  attachmentId: attachment.attachmentId,
                })
                if (result.isError) {
                  console.log(`Skipped ${attachment.filename}: Mail error`)
                  return null
                }
                // Files come back base64-encoded: images as `data`, other
                // files as `resource.blob`.
                const items = result.content as Array<{
                  data?: string
                  resource?: { blob?: string }
                }>
                const base64 = items
                  .map((item) => item.resource?.blob ?? item.data)
                  .find((value) => value !== undefined)
                if (!base64) {
                  console.log(`Skipped ${attachment.filename}: no file data`)
                  return null
                }
                const upload = await context.notion.fileUploads.create({
                  mode: "single_part",
                  filename: attachment.filename,
                  content_type: attachment.mimeType,
                })
                await context.notion.fileUploads.send({
                  file_upload_id: upload.id,
                  file: {
                    filename: attachment.filename,
                    data: new Blob([Buffer.from(base64, "base64")], {
                      type: attachment.mimeType,
                    }),
                  },
                })
                return upload.id
              }
            )
            if (id) {
              files.push({ id, name: attachment.filename })
            }
          }
        }

        await context.step(`Add ${key}`, async () => {
          await context.notion.pages.create({
            parent: { data_source_id: context.access.referrals.id },
            properties: {
              Name: {
                title: [{ text: { content: first.subject || "(no subject)" } }],
              },
              "Candidate email": { email: findCandidateEmail(first, mailbox) },
              "Referred by": { email: first.from.address },
              Received: { date: { start: first.date } },
              Attachments: {
                files: files.map(({ id, name }) => ({
                  type: "file_upload" as const,
                  file_upload: { id },
                  name,
                })),
              },
              Email: { url: thread.url ?? null },
              "Thread ID": { rich_text: [{ text: { content: key } }] },
            },
            markdown: threadMarkdown(thread.messages),
          })
        })
      }

      pageToken = search.cursor
      page++
    } while (pageToken)
  },
})
