# Referral Tracker

A Notion App that turns referral and resume emails into rows in a Notion
**Referrals** database. Each row has the candidate's email, who sent it, the
email's attachments, and the full email text on the page. It uses plain code,
not AI.

> [!WARNING]
>
> Notion Apps and the Apps SDK are early alpha features and can introduce
> breaking changes.

## How it works

The `trackReferrals` workflow has two triggers:

- **New email:** when an email arrives whose subject or body contains
  "referral", "resume", or "résumé", it searches the last 2 days of mail for
  those words.
- **Manual run:** searches all of your mail for those words. Use it once to
  add past referrals.

For each matching thread, the workflow:

1. Skips the thread if **Referrals** already has a row with its **Thread ID**.
   The Gmail thread ID is the dedupe key, so every thread gets one row no
   matter how many times the workflow runs.
2. Reads every message in the thread with `viewThreadContent`.
3. Copies each non-inline attachment into Notion with `readAttachment` and the
   Notion file upload API. Mail cannot read attachments over about 3 MB; those
   are left out and the row is still added.
4. Adds the row:

   | Property        | Value                                                 |
   | --------------- | ----------------------------------------------------- |
   | Name            | The first message's subject                           |
   | Candidate email | See below                                             |
   | Referred by     | The first message's sender                            |
   | Received        | The first message's date                              |
   | Attachments     | The thread's attachments                              |
   | Email           | A link to the thread, when Mail returns one           |
   | Thread ID       | The dedupe key (hidden in the table)                  |
   | Page body       | Every message in the thread, with its sender and date |

The candidate's email comes from the first message, in this order:

1. The first address in the text that is not the sender, your mailbox, or a
   "to" recipient. Referrers often paste the candidate's email, and a
   forwarded resume keeps the original sender in the text.
2. The first CC that is not the sender or your mailbox.
3. The sender, when it is not your mailbox. Candidates sometimes send their
   own resume.

## Prerequisites

- Node.js 26 or newer and the `ntn` CLI.
- A Gmail account connected to Notion Mail. The searches use Gmail search
  syntax.

## Setup

```shell
cd apps/templates/referral-tracker
npm install
npm run check
npm test
npm run build

ntn experiments enable apps
ntn login
ntn apps deploy --name "Referral Tracker"   # omit --name on later deploys
```

After deploying, open the App's setup in Notion, connect Mail, and pick the
mailbox for **referrals**. The App can only read that mailbox.

To add past referral emails:

```shell
ntn apps workflows trigger trackReferrals
```

Running it again is safe: threads already in **Referrals** are skipped.

## Code map

```text
APP.md                            Home page: embedded Referrals table
src/connections/inbox.ts          Mail connection with one Gmail target
src/notion.ts                     Referrals database and table view
src/workflows/trackReferrals.ts   Triggers, Mail reads, uploads, and rows
src/workflows/lib/referral.ts     Matching, dedupe key, candidate email, and
                                  page body (tested)
```

## Extension points

- **Other words:** change `REFERRAL_PATTERN` and `REFERRAL_QUERY` in
  `referral.ts`. Keep them matching the same words.
- **One row per message:** use the message ID instead of the thread ID as the
  dedupe key.
- **Only some mail:** add Gmail operators such as `label:Referrals` or
  `-from:me` to `REFERRAL_QUERY`.

## Verification

`npm test` covers word matching, the dedupe key, candidate email choice, and
the page body offline. To check the live flow, send yourself an email with
"referral" in the subject, a candidate's email in the body, and a small PDF.
Confirm that one row appears with the PDF attached. Then run the manual trigger
and confirm the row is not added again.
