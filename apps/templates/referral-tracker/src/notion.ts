import { database } from "@notionhq/apps"

// Resource IDs are stable identities. Do not rename them after deploying.
export const referrals = database("referrals-db", {
  dataSourceResourceId: "referrals-source",
  name: "Referrals",
  icon: { type: "emoji", emoji: "🤝" },
  schema: {
    Name: { resourceId: "referral-name", type: "title" },
    "Candidate email": { resourceId: "referral-candidate", type: "email" },
    "Referred by": { resourceId: "referral-from", type: "email" },
    Received: { resourceId: "referral-received", type: "date" },
    Attachments: { resourceId: "referral-attachments", type: "file" },
    Email: { resourceId: "referral-email-url", type: "url" },
    // Dedupe key: the Gmail thread ID. One row per email thread.
    "Thread ID": { resourceId: "referral-thread-id", type: "text" },
  },
})

export const referralsTable = referrals.addView({
  resourceId: "referrals-table",
  name: "All referrals",
  type: "table",
  dataSourceResourceId: "referrals-source",
  properties: [
    { property: "referral-name", visible: true },
    { property: "referral-candidate", visible: true },
    { property: "referral-from", visible: true },
    { property: "referral-received", visible: true },
    { property: "referral-attachments", visible: true },
    { property: "referral-email-url", visible: true },
    { property: "referral-thread-id", visible: false },
  ],
})
