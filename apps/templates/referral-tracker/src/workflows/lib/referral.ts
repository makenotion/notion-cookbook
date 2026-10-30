// Plain helpers for referral emails. They do not call Mail or Notion, so they
// can be tested offline.

// Matches "referral", "resume", and "résumé" anywhere in a subject or body.
export const REFERRAL_PATTERN = /referral|r[eé]sum[eé]/i

// Gmail search for the same words. Gmail matches subjects and bodies.
export const REFERRAL_QUERY = "referral OR resume OR résumé"

export type Address = { address: string; name?: string }

// The fields this App reads from a viewThreadContent message.
export type MailMessage = {
  messageId: string
  subject?: string
  date: string
  from: Address
  to?: Address[]
  cc?: Address[]
  textWithoutUrls?: string
  attachments?: Array<{
    attachmentId: string
    filename: string
    mimeType: string
    inline: boolean
  }>
}

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g

/**
 * Thread IDs can end in a verification stamp after a "." The part before it
 * is the thread, so it is the dedupe key.
 */
export function threadKey(threadId: string): string {
  return threadId.split(".")[0]
}

/**
 * Picks the candidate's email from the first message of a thread:
 * 1. The first address in the text that is not the sender, the mailbox, or a
 *    "to" recipient. Referrers often paste the candidate's email, and a
 *    forwarded resume keeps the original sender in the text.
 * 2. Otherwise, the first CC that is not the sender or the mailbox. Referrers
 *    often CC the candidate.
 * 3. Otherwise, the sender, when it is not the mailbox. Candidates sometimes
 *    send their own resume.
 */
export function findCandidateEmail(
  message: MailMessage,
  mailbox: string
): string | null {
  const sender = message.from.address.toLowerCase()
  const skip = new Set([
    sender,
    mailbox.toLowerCase(),
    ...(message.to ?? []).map(({ address }) => address.toLowerCase()),
  ])
  const inText = (message.textWithoutUrls ?? "").match(EMAIL_PATTERN) ?? []
  for (const address of inText) {
    if (!skip.has(address.toLowerCase())) {
      return address.toLowerCase()
    }
  }
  for (const { address } of message.cc ?? []) {
    const lower = address.toLowerCase()
    if (lower !== sender && lower !== mailbox.toLowerCase()) {
      return lower
    }
  }
  return sender === mailbox.toLowerCase() ? null : sender
}

/** Page body: every message in the thread, oldest first. */
export function threadMarkdown(messages: MailMessage[]): string {
  return messages
    .map((message) => {
      const from = message.from.name
        ? `${message.from.name} (${message.from.address})`
        : message.from.address
      return [
        `**From:** ${from}`,
        `**Date:** ${message.date}`,
        "",
        (message.textWithoutUrls ?? "").trim(),
      ].join("\n")
    })
    .join("\n\n---\n\n")
}
