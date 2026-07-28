# Trademark Portfolio Template

This turns your company's trademark portfolio into a live, self-updating
database inside **Notion** — every application and registration worldwide,
where each one stands, and what's due next: office-action responses,
Statements of Use, oppositions, renewals. It pulls public data from the
**USPTO** (US marks) and **TMview** (a free aggregator covering most other
trademark offices) automatically, and it can read your outside counsel's own
docket reports, so counsel's exact deadlines and instructions show up right
next to the registry data.

You do **not** need to know how to code. You set it up by talking to an AI
coding assistant — **[Claude Code](https://www.claude.com/claude-code)** or
**[Codex](https://openai.com/codex)** — in plain English. It runs all the
technical commands for you and asks simple questions along the way, so you
never have to open a terminal unless you want to.

And unlike most data integrations: **there are no API keys to get.** The
only thing the template needs is your company's name as the offices know it.

---

## Onboarding — getting it running (no coding required)

Plan for about **20 minutes**. You'll need:

- A **Notion workspace with Workers enabled.** Workers are a **Business or
  Enterprise** feature (not available on Free, Plus, or Education plans), and
  a **Workspace Owner** has to enable Workers for the workspace (see Notion's
  [Workers help](https://www.notion.com/help/understand-pricing-for-workers)
  for the setting and pricing). They run on Notion credits (a small per-run
  cost; this template's hourly schedule is light). Not sure about any of
  this? Ask whoever owns your Notion workspace.

  > **What's a Notion Worker?** It's a small program that runs on Notion
  > servers — there's nothing for you to host or keep running. On a schedule,
  > it fetches data from outside services (here, the trademark registries and
  > your counsel's reports) and writes it into a Notion database for you. This
  > template _is_ a worker: once it's deployed you never touch it directly —
  > you just open the **Trademark Portfolio** database it keeps up to date.

- An **AI coding assistant with access to your computer** — such as
  **Claude Code** ([claude.com/claude-code](https://www.claude.com/claude-code))
  or **Codex** ([openai.com/codex](https://openai.com/codex)). Install one or
  ask IT for help. It's the "assistant" you'll talk to, and it runs the
  terminal commands below on your behalf.
- **Node.js version 22 or newer** — the runtime this tool is built on. Your
  assistant can check for it and install it for you. In a terminal yourself:
  `node --version` to check; install the "LTS" version from
  [nodejs.org](https://nodejs.org) if it's missing or older.
- The **`ntn` command-line tool** — Notion's CLI that connects to your
  workspace and deploys the worker. Again, your assistant can install this
  for you. In a terminal: `curl -fsSL https://ntn.dev | bash`, then
  `ntn --version` to check.

  _In short, you don't have to run any of these yourself — the `/setup`
  routine (Step 3) checks for Node and `ntn` and installs anything missing.
  The terminal commands are here for whoever prefers to run them by hand._

- **No API keys.** Really. The patent version of this template makes you
  register for developer keys before anything works; the trademark
  registries are kinder. USPTO search and TMview are both free and keyless —
  no registration, no approval wait, nothing to paste. Upgrades that _do_
  take a key (fresher US data, official AU/EU overlays) come later, one at a
  time — see "Going further" at the end.

### Step 1 — Find your exact owner name

This replaces the "get your API keys" step other templates start with — and
it's the single most important answer you'll give. The tool finds your marks
by searching the registries for your company as the recorded **owner /
applicant**, and the offices match that name **literally**. Get the exact
legal entity right: many companies hold marks under a specific subsidiary
(e.g. "ACME Technologies LLC", not just "ACME").

Two free lookups confirm the exact string in a couple of minutes:

1. **For US marks — TSDR** ([tsdr.uspto.gov](https://tsdr.uspto.gov)): enter
   the serial or registration number of a mark you know is yours, and read
   the **Current Owner** name off the status page, character for character.
   (No number handy? Search your company name at
   [tmsearch.uspto.gov](https://tmsearch.uspto.gov) and open one of your marks.)
2. **For everywhere else — TMview**
   ([tmdn.org/tmview](https://www.tmdn.org/tmview/)): use **Advanced search**
   → **applicant name**; confirm the results are really yours and note the
   spelling(s) used.

> **List every variant you find.** If your marks are split across "ACME
> Corporation", "ACME Corp." and "ACME Holdings B.V.", write all three down —
> the template accepts a list, and you'll hand it to the assistant in Step 3.

### Step 2 — Get this example onto your computer and open it

This example lives inside Notion's **cookbook** repository, in the
`workers/trademark-portfolio-sync/` folder. You need a copy of it on your
machine, then open it in your assistant. The easiest path is to let the
assistant do it: open Claude Code or Codex, then ask — _"Download the
notion-cookbook repo from github.com/makenotion/notion-cookbook and open the
workers/trademark-portfolio-sync folder"_ — and it'll handle the rest.

To get the copy yourself, either:

- **Download a ZIP (no Git needed):** on the cookbook's GitHub page
  ([github.com/makenotion/notion-cookbook](https://github.com/makenotion/notion-cookbook)),
  click the green **`< > Code`** button → **Download ZIP**. Unzip it somewhere
  easy to find; the example is inside at `workers/trademark-portfolio-sync/`.
- **Clone with Git (if you're in a terminal):** run

  ```shell
  git clone https://github.com/makenotion/notion-cookbook.git ~/Developer/notion-cookbook
  ```

  Cloning is the better option if you might pull updates later — `git pull`
  refreshes your copy, whereas a ZIP is a one-time snapshot.

Then open the example folder in your assistant: launch **Claude Code** or
**Codex** and, when it asks which folder to open (or trust), point it at
`workers/trademark-portfolio-sync/` inside the cookbook you just downloaded.

### Step 3 — Start the guided setup and answer the questions

Kick off the guided setup from inside your assistant:

- **In Claude Code:** type `/setup` and press enter.
- **In Codex (or another assistant):** ask it to _"run the setup guide in
  this repo"_ — it follows the same instructions (`.claude/commands/setup.md`).

Either way, it walks you through everything, asking plain questions. You'll
provide:

- **Your owner name(s)** from Step 1 — exactly as the offices record them.
  It's how the tool finds your marks, so the spelling matters more than
  anything else you'll type today.
- A few **optional choices** — the Docket Inbox (Step 6, worth doing but fine
  to defer), official AU/EU overlays, a billing system. You can say
  **no / skip** to all of these for now and add them later. There are **no
  keys to paste** for the base setup.

### Step 4 — Deploy (approve the login when your browser opens)

The assistant then connects to your Notion workspace — you'll approve a login
in your browser — and deploys the worker. **The Trademark Portfolio database
is created automatically on this first deploy** — you don't make it by hand.
It appears in your workspace (typically in your private space), alongside a
second **Sync Health** database that flags if a data source goes down.

> If the assistant hits a **deploy** error mentioning Workers, a
> _capability_, or a **403** (e.g. `WorkersCapabilityMissing` or
> `CapabilityNotEnabledError`), Workers aren't fully enabled for your
> account. Have a **Workspace Owner** turn them on for the workspace (see
> Notion's
> [Workers help](https://www.notion.com/help/understand-pricing-for-workers)).
> Because this template _syncs_ data, the sync capability may also need to be
> enabled for your specific user during the beta — your admin can request that.

### Step 5 — Run the first backfill and open your portfolio

The setup finishes by triggering a one-time **full load** (the "backfill"),
and from then on the portfolio is **kept in sync automatically every hour**.
Open Notion when the assistant says it's done and you'll see your marks —
status, classes, dates, and a computed **Next Deadline** on each row.

> If something looks off (e.g., few or no marks show up), tell the assistant
> — most often the owner name needs to match the registry's spelling exactly
> (re-check it on TSDR / TMview as in Step 1). And know that TMview is a
> mirror of ~75 offices with varying freshness, not the register of record —
> the optional overlays in "Going further" tighten that up for AU and EU.

### Step 6 — Optional: connect your counsel's docket (the Docket Inbox)

This is the template's docketing integration, and it needs **no API and no
IT project on your counsel's side** — just two spreadsheets. Registry data
can't know your _intent_ (which marks you've told counsel to let lapse),
your firm's _exact docketed dates_, or filings made directly in offices no
aggregator indexes. Counsel's docketing system knows all three.

**What to ask your outside counsel for.** Two standard `.xlsx` exports —
nearly every commercial docketing system produces both in a few clicks:

- a **Docket Report** — the upcoming trademark deadlines they're tracking
  for you, with due dates;
- a **Properties Report** — the full list of your rights, all countries, with
  application/registration numbers and statuses.

Something like: _"Could you send us (1) a docket report of our upcoming
trademark deadlines and (2) a full properties report of our portfolio, both
as Excel exports? We'd like a refreshed pair periodically."_ Ask them to keep
**"Docket Report"** / **"Properties"** in the filenames, with the report date
at the end as MMDDYYYY — e.g. `ACME - Docket Report 07172026.xlsx`,
`ACME - Properties Report 07172026.xlsx`. The worker classifies files by
name, and always uses the newest of each kind by that date token.

**Set it up once** (your assistant can do all of this if you ask):

1. Create a Notion page called **Docket Inbox** and drag the two `.xlsx`
   files onto it as attachments.
2. Give the worker's Notion integration access to that page: open the page,
   click **⋯ → Connections**, and add the integration (the assistant can
   help you create one first if needed).
3. Tell your assistant to _"enable the counsel docket source"_ — it sets the
   two env values, flips the source on in `src/config.ts`, records your
   client number (so another client's report is refused), and re-runs the
   backfill.

**What you get.** Counsel's exact docketed dates **override** the computed
estimates wherever they cover a mark; marks counsel has been instructed to
abandon get a **Lapse Instructed** checkbox (the register shows a healthy
registration for months after that decision — this flag is where the intent
lives); and direct national filings no aggregator indexes get their own rows.

**What the guards protect against.** The ingester refuses a report exported
for a different client, a portfolio that doesn't match your owner names, a
truncated export, and a portfolio that suddenly shrank by more than 40% — and
a refused report is harmless: the previous good one keeps serving. The
**Counsel Docket Inbox** row in Sync Health dry-runs the entire parse every
15 minutes, so a bad or misnamed file goes visibly red. From then on,
updating is literally drag-and-drop: when counsel sends a new pair, drop
them on the same page and the next hourly cycle picks them up.

---

## Using your portfolio in Notion

### One database, three kinds of rows

Everything lands in one **Trademark Portfolio** database:

- **US rows** — from the USPTO, keyed by serial number.
- **Everything-else rows** — from TMview (refined by official overlays where
  enabled). A Madrid international registration is one **WO** row carrying
  its designated countries in **Jurisdiction**.
- **Counsel-only rows** — filings that exist only in your counsel's
  Properties Report; their **Office Status** ends in "(counsel docket)".

**Office** is the register a row lives at; **Jurisdiction** is where
protection extends. Filter or group by either.

### Recommended starter views

The worker manages your data and columns, not the layout — so it can't create
views for you. Set these up once in Notion (they survive every sync), or ask
your assistant to build them. Each is a few clicks: **+ Add view**, pick the
type, set its **Filter**, **Sort**, and **Properties**. Five that cover most
trademark work:

- **Upcoming deadlines** — _Table._ Filter **Next Deadline is not empty**;
  sort **Next Deadline** ↑. Show: Mark, Office, Deadline Type, Next Deadline,
  Status, Serial #, Reg. #, Docket #. An overdue date means "look into it" —
  the estimates deliberately don't model extensions or grace periods.
- **By office** — the world map, roughly.
  _Board._ Group by **Office**; show Status and Next Deadline on the cards.
- **Lapse instructed** (with the Docket Inbox connected) — _Table._ Filter
  **Lapse Instructed is checked**: the marks being deliberately let go; a
  periodic skim confirms nothing landed here by mistake.
- **Renewals this fiscal year** — budgeting's favorite.
  Duplicate **Upcoming deadlines**; filter **Deadline Type is §8/§9 Renewal
  or Renewal** and **Next Deadline is within** your fiscal year.
- **Recently changed** — _Table._ Sort **Last Sync** ↓. Last Sync only
  advances when a row actually changes, so the top of this view is "what
  moved lately."

### Make it your own (views, columns, properties)

The database comes **with a range of properties already populated** — status,
dates, classes, registry links, deadlines, and more. That's intentionally a
starting point, not a finished layout. Shape it to how your team works,
directly in Notion — the hourly refresh leaves your views and hidden columns
alone:

- **Add more views** — group by **Type** or **Classes**, filter to a single
  office, whatever your reviews need.
- **Hide properties you don't need.** Open a view's **Properties** menu and
  toggle columns off to declutter — the data stays, just out of sight.
- **Add your own properties** — notes, an internal owner, a brand-family tag.
  The sync only writes the columns it manages and won't touch ones you add
  yourself. (The optional mark-image tool fills a **Mark Image** files
  property and the page icons the same way — outside the managed columns.)

> Want a property the sync should _populate_ (not a manual one), or want to
> remove a managed column entirely? That's a schema change — ask your
> assistant. See [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Optional: pair it with a custom agent

Because your portfolio is a live database, it makes a great foundation for a
**custom agent** — Notion's no-code automations that read and act on your
data on a schedule or when something changes. (The template is a _worker_,
which fills the database; agents are an optional layer on top.) Every agent
is three things: a **trigger** (when it runs), **instructions** (what to do,
in plain language), and **access** (what it can see and touch). Start each on
a **manual** trigger while you test, then turn on the schedule once it
behaves — agents consume Notion credits.

Three that pair well with the portfolio:

### Office Action Summarizer

Turns each incoming refusal into a plain-English brief. (Needs the optional
`TSDR_API_KEY` — see "Going further" — because it uses the document tools.)

- **First, add a property:** create a text column called **OA Summary** on
  the Trademark Portfolio database — the sync never touches columns you add.
- **Trigger:** when a property is updated (it fires when a sync sets
  **Deadline Type** to OA Response) — or run it manually to catch up.
- **Instructions:** _"For each row whose **Deadline Type** is OA Response and
  whose **OA Summary** is empty, call `listTrademarkDocuments` with the row's
  **Serial #**, find the most recent office action, attach it to the row's
  page with `attachTrademarkDocumentToPage`, then read it and summarize the
  refusals raised and the response deadline into **OA Summary**."_
- **Access:** read + edit the Trademark Portfolio database; the worker's
  tools. Attach one document per row per run — the upstream PDF endpoint
  allows roughly four per minute.

### Renewal & Maintenance Watch

Surfaces upcoming maintenance so a renewal never slips — the highest-stakes
job in a trademark portfolio.

- **Trigger:** scheduled, weekly.
- **Instructions:** _"In the Trademark Portfolio database, find every row
  where **Next Deadline** is within the next 90 days, excluding rows whose
  **Lapse Instructed** is checked or whose **Status** is Abandoned, Cancelled,
  or Expired. Post a digest grouped by **Office**: Mark, Serial # / Reg. #,
  Deadline Type, and the date. Flag anything overdue as 'verify with counsel'
  — the dates are estimates unless counsel's docket covers the mark. If
  nothing is due, say so."_
- **Access:** read the Trademark Portfolio database; post to one Slack
  channel or a Notion page.

### New Filing Announcer

Lets the brand and product teams see protection landing as it happens.

- **Trigger:** event — _a page is added_ to the database (new filings arrive
  with the hourly sync).
- **Instructions:** _"When a new row appears, post to the brand channel:
  'New filing — {Mark} ({Office}, {Classes}), filed {Filed}, status
  {Status}.' Don't announce the same mark twice."_
- **Access:** read the Trademark Portfolio database; post to one Slack
  channel.

For the full how-to on building, sharing, and testing agents, see Notion's
[custom agents guide](https://www.notion.com/help/custom-agents).

---

## Going further

Once you're up and running, everything is an independent upgrade — no
redeploys, and your assistant can do each one for you:

- **Fresher US data + documents: add a TSDR key.** A free key from the
  [USPTO API portal](https://account.uspto.gov/api-manager/) upgrades US rows
  to same-day freshness and unlocks the **document tools** — listing a mark's
  file-wrapper documents (office actions, specimens, registration
  certificates) and attaching them to Notion pages, plus `refreshMarkImages`
  for in-table mark images and page icons.
- **Official overlays for AU and EU.** IP Australia
  ([portal.api.ipaustralia.gov.au](https://portal.api.ipaustralia.gov.au))
  and the EUIPO ([dev.euipo.europa.eu](https://dev.euipo.europa.eu)) offer
  free official APIs that refine TMview's mirror with authoritative statuses
  and renewal dates. Both require registration and approval — EUIPO's is the
  slow part, so start it early; the **EUIPO** row in Sync Health stays red
  until the approval lands, by design.
- **Cost per mark.** Connect your e-billing system by implementing the stub
  in `src/sources/spend.example.ts` — trademark matters are usually named
  after the mark, which is the practical join.

For how it all works — the sources, the sync model and **hourly** cadence,
the resilience design, the manual quickstart, and an outage runbook — see
[`ARCHITECTURE.md`](ARCHITECTURE.md). Deeper design notes for your AI
assistant live in [`AGENTS.md`](AGENTS.md) and `.claude/skills/`.

New to Notion Workers in general? Notion's own docs are the source of truth:
[Run custom code with Workers](https://www.notion.com/help/run-custom-code-with-workers)
(Help Center) and the
[Workers developer docs](https://developers.notion.com/workers/get-started/overview).

## License

[MIT License](../../LICENSE).
