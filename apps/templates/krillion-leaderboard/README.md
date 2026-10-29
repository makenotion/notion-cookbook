# Krillion Leaderboard

A Notion App that posts a daily Krillion leaderboard to
a Slack channel. People paste their results in the channel, and every evening
the App posts the top 3 scores for that day's puzzle. It uses plain code, not
AI.

> [!WARNING]
>
> Notion Apps and the Apps SDK are early alpha features and can introduce
> breaking changes.

## How it works

The `postLeaderboard` workflow runs daily at 6 pm `America/Los_Angeles`. It:

1. Reads the channel's threads from the last 24 hours with
   `getThreadsInChannelSince`. Only the first message of each thread from a
   person counts. Replies, bot posts, and screenshots are skipped.
2. Finds results shaped like Krillion's share text:

   ```text
   Krillion #106 🦐
   495

   🏮🏮🦑🦑🏮🦑🦑
   ```

   Extra words before the result, after the header, or after the emoji row are
   fine.

3. Uses the puzzle number most people posted, so a few late posts for the
   previous puzzle do not count. Keeps each player's best score.
4. Posts the top 3 as a new message:

   ```text
   Krillion #106 🦐 KRILLION LEADERBOARD
   @player - 495 🏮🏮🦑🦑🏮🦑🦑
   ```

   Ties go to whoever posted first. If nobody posted a result, it posts
   nothing.

## Prerequisites

- Node.js 26 or newer and the `ntn` CLI.
- A Slack workspace connected to Notion, and a channel where people post their
  Krillion results.

## Setup

```shell
cd apps/templates/krillion-leaderboard
npm install
npm run check
npm test
npm run build

ntn experiments enable apps
ntn login
ntn apps deploy --name "Krillion Leaderboard"   # omit --name on later deploys
```

After deploying, open the App's setup in Notion, connect Slack, and pick the
channel for **krillion**. The App can only read and post in that channel.

To post a leaderboard now instead of waiting for 6 pm:

```shell
ntn apps workflows trigger postLeaderboard
```

## Code map

```text
APP.md                              Home page
src/connections/slack.ts            Slack connection with one channel target
src/workflows/postLeaderboard.ts    Schedule, Slack reads, and the post
src/workflows/lib/leaderboard.ts    Result parsing and ranking (tested)
```

## Extension points

- **More places:** change `PLACES` in `leaderboard.ts`.
- **Another time:** change the `events.scheduled` time and time zone in
  `postLeaderboard.ts`.
- **Another game:** change the `RESULT` pattern and header in
  `leaderboard.ts`.

## Verification

`npm test` covers result parsing, puzzle choice, best scores, ties, and empty
days offline. To check the live flow, run the manual trigger after a few people
have posted, and confirm the leaderboard appears in the channel.
