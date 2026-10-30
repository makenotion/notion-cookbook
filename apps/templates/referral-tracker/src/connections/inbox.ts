import { connections } from "@notionhq/apps"

// The person who installs the App picks the mailbox in setup. Gmail is
// required because the backfill uses Gmail search syntax.
export default connections.mail({
  referrals: {
    description: "Mailbox that gets referral and resume emails",
    permissions: ["read"],
    multiple: false,
    provider: "GMAIL",
  },
})
