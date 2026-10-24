# Send email when a Notion task status changes

Watch a Notion task database and notify people through SendGrid when an
existing page's **Status** changes.

> [!CAUTION]
> This is a continuous process that polls Notion every **5 seconds** and sends
> **real emails** to `EMAIL_TO_FIELD`. Use a test database and recipient while
> setting it up. The process runs until you stop it with `Ctrl+C`.

<img src="https://dev.notion.so/front-static/external/readme/images/notion-email-example@2x.png" alt="A Notion status update triggering an email" width="500"/>

## Quickstart

1. Duplicate the
   [example task database](https://public-api-examples.notion.site/0def5dfb6d9b4cdaa907a0466834b9f4?v=aea75fc133e54b3382d12292291d9248)
   into your workspace.
2. Create a Notion integration in the
   [integrations dashboard](https://www.notion.com/my-integrations), then
   [connect it to the duplicated database](https://developers.notion.com/docs/create-a-notion-integration#step-2-share-a-database-with-your-integration).
3. Create a SendGrid API key and verify the sender address you plan to use.
4. From the repository root, install and configure the example:

   ```sh
   cd examples/database-email-update
   npm install
   cp example.env .env
   ```

   Fill in `.env`:

   ```dotenv
   NOTION_KEY=<your-notion-api-key>
   SENDGRID_KEY=<your-sendgrid-api-key>
   NOTION_DATABASE_ID=<your-test-database-id>
   EMAIL_TO_FIELD=<test-recipient@example.com>
   EMAIL_FROM_FIELD=<your-verified-sender@example.com>
   ```

5. Start the watcher:

   ```sh
   npm run ts-run
   ```

## What to expect

At startup, the process reads every page and stores its current Status in
memory. It does not email for this initial snapshot. After the first fetch
succeeds, the command stays running and checks the database every 5 seconds.

To verify it, change the Status of an existing page while the process is
running. Within about 5 seconds, the terminal reports the changed task. After
SendGrid accepts the message, it prints `Email Sent` with the recipient and
sender, and the recipient receives a real email.

Press `Ctrl+C` to stop polling. Changes made while the process is stopped are
not sent later because each restart takes a new initial snapshot.

This example expects a title property named **Name** and a select property
named **Status**, as provided by the example database.
