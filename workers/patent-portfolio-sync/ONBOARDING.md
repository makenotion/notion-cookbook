# Patent Portfolio Template

This turns your company's patent portfolio into a live, self-updating database
inside **Notion** — so you can see every application and grant, how they group
into families, where each one stands, and (once you connect your systems) what
they're costing. It pulls public data from the **US** and/or **European**
patent offices automatically — start with whichever one you have, add the
other anytime — and you can plug in your own docketing and legal-billing
systems later.

You do **not** need to know how to code. You set it up by talking to an AI
coding assistant — **[Claude Code](https://www.claude.com/claude-code)** or
**[Codex](https://openai.com/codex)** — in plain English. It runs all the
technical commands for you and asks simple questions along the way, so you
never have to open a terminal unless you want to.

---

## Onboarding — getting it running (no coding required)

Plan for about **30 minutes**. You'll need:

- A **Notion workspace with Workers enabled.** Workers are a **Business or
  Enterprise** feature (not available on Free, Plus, or Education plans), and a
  **Workspace Owner** has to enable Workers for the workspace (see Notion's
  [Workers help](https://www.notion.com/help/understand-pricing-for-workers)
  for the workspace setting and pricing). They run on Notion credits (a small
  per-run cost; this template's hourly schedule is light). If you're not sure
  any of this is set up, ask whoever owns your Notion workspace.

  > **What's a Notion Worker?** It's a small program that runs on Notion
  > servers — there's nothing for you to host or keep running. On a schedule, it
  > fetches data from outside services (here, the US and European patent
  > offices) and writes it into a Notion database for you. This template _is_ a
  > worker: once it's deployed you never touch it directly — you just open the
  > **Patent Portfolio** database it keeps up to date.

- An **AI coding assistant with access to your computer** — such as **Claude Code**
  ([claude.com/claude-code](https://www.claude.com/claude-code)) or **Codex**
  ([openai.com/codex](https://openai.com/codex)). Install one or ask IT for help setting it up. It's the "assistant" you'll talk to, and it
  runs the terminal commands below on your behalf.
- **Node.js version 22 or newer** — the runtime this tool is built on. Your
  assistant can check for it and install it for you. If you're working in a
  terminal yourself: run `node --version` to check, and install the "LTS"
  version from **https://nodejs.org** if it's missing or older (it adds both
  `node` and `npm`).
- The **`ntn` command-line tool** — Notion's CLI that connects to your
  workspace and deploys the worker. Again, your assistant can install this for
  you. If you're in a terminal: run `curl -fsSL https://ntn.dev | bash` to
  install it, then `ntn --version` to check.

  _In short, you don't have to run any of these yourself — just ask your
  assistant to get you set up, and the `/setup` routine (Step 4) checks for
  Node and `ntn`, installing anything missing, before it does anything else.
  The terminal commands are here for whoever prefers to run them by hand._

- At least **one free API key** (think of an API key as a read-only password
  that lets the tool fetch public patent data). You need **either** the US key
  **or** the European key to start — getting both is great, but one is enough
  to deploy and see your portfolio. You can add the second office later without
  redoing anything. Getting the key(s) is Steps 1–2 below.

### Step 1 — Get your USPTO key (United States patents)

_Skip if you only file in Europe — but most US-based companies want this one._

The key lives in the **Open Data Portal (MyODP)** — note this is a _different_
site from the older **MyUSPTO** portal, which is easy to land on by mistake.

1. Go to the Open Data Portal registration page:
   **https://data.uspto.gov/support/universal-registration** — this is where
   you request access to the ODP APIs (part of data.uspto.gov — _not_
   my.uspto.gov).
2. Sign in with a **USPTO.gov account that is verified with ID.me**. USPTO
   requires this identity check before it will issue an API key — if your
   account isn't verified yet, you'll be prompted to link ID.me (a one-time
   step). Verifying can take a few minutes if you don't already have ID.me.
3. Once verified, create your API key on MyODP — it's free and **issued
   instantly** (no waiting for approval). Copy and paste
   it in Step 4.

> **If the key errors the first time you use it, wait a couple minutes and try
> again.** A freshly created key can take a few minutes to activate on USPTO's
> side, so an early request may fail before it starts working — this is normal,
> not a setup mistake.

### Step 2 — Get your EPO key (European patents)

_Skip if you only file in the US — you can add Europe later._

The EPO is the reverse of the USPTO: **no identity verification**, but your
developer account must be **approved by the EPO before you can generate keys**
— this isn't instant, so start it early.

1. Register a free account at **https://developers.epo.org** (the European
   Patent Office's "Open Patent Services"), choosing **Non-paying** access.
2. **Wait for the confirmation email** from the EPO Developer Portal approving
   your account. You can't create keys until this arrives (often quick, but it
   can take longer — it's a manual gate, not automatic).
3. Once approved, log in, open **My Apps → Add a new App** (choose the
   **OPS / Core** APIs). It gives you two values: a **Consumer Key** and a
   **Consumer Secret**. Copy both.

### Step 3 — Get this example onto your computer and open it

This example lives inside Notion's **cookbook** repository, in the
`examples/workers/syncs/patent-portfolio/` folder. You need a copy of it on your
machine, then open it in your assistant (**Claude Code** or **Codex**). The
easiest path is to let the assistant do it: open Claude Code or Codex, then ask
— _"Download the notion-cookbook repo from github.com/makenotion/notion-cookbook
and open the examples/workers/syncs/patent-portfolio folder"_ — and it'll handle
the rest.

To get the copy yourself, either:

- **Download a ZIP (no Git needed):** on the cookbook's GitHub page
  ([github.com/makenotion/notion-cookbook](https://github.com/makenotion/notion-cookbook)),
  click the green **`< > Code`** button → **Download ZIP**. Unzip it somewhere
  easy to find, like your `~/Developer` folder; the example is inside at
  `examples/workers/syncs/patent-portfolio/`.
- **Clone with Git (if you're in a terminal):** run
  ```shell
  git clone https://github.com/makenotion/notion-cookbook.git ~/Developer/notion-cookbook
  ```
  Cloning is the better option if you might pull updates later — `git pull`
  refreshes your copy, whereas a ZIP is a one-time snapshot.

Then open the example folder in your assistant: launch **Claude Code** or
**Codex** and, when it asks which folder to open (or trust), point it at
`examples/workers/syncs/patent-portfolio/` inside the cookbook you just
downloaded.

### Step 4 — Start the guided setup and answer the questions

Kick off the guided setup from inside your assistant:

- **In Claude Code:** type `/setup` and press enter.
- **In Codex (or another assistant):** ask it to _"run the setup guide in this
  repo"_ — it follows the same instructions (in `.claude/commands/setup.md`).

Either way, it walks you through everything, asking plain questions. You'll
provide:

- **Your company's applicant/assignee name** — exactly as it appears on your
  patents (for example, "Acme Corporation"). This is the single most important
  answer: it's how the tool finds your filings, and the offices match it
  literally. Get the exact legal entity right — large companies often hold
  patents under a specific subsidiary or holding entity (e.g. "Acme
  Technologies LLC", not just "Acme").

  > **Sanity-check it on Google Patents first.** Go to
  > [patents.google.com](https://patents.google.com), search
  > `assignee:"Your Company Name"`, and confirm the results are really your
  > patents and that the spelling matches what's printed on them. If a
  > different spelling or a subsidiary returns the right patents, use that. You
  > can list several names if you file under more than one.

- **Which office(s) you have keys for** — US, Europe, or both. The assistant
  turns on just those and only asks for the keys you actually have.
- **The key(s) from Steps 1–2** — paste them when asked.
- A few optional choices (connecting your docketing or billing systems, and an
  "advanced" menu) — you can say **no / skip** to all of these for now and add
  them later.

The assistant then connects to your Notion workspace (you'll approve a login in
your browser) and deploys the worker. **The Patent Portfolio database is
created automatically in your workspace on this first deploy** — you don't make
it by hand — and then **kept in sync automatically every hour** from there on
(plus a one-time full load right after setup). It appears in your workspace
(typically in your private space) titled **Patent Portfolio**; open Notion when
the assistant finishes and you'll see it filled in. (A second **Sync Health**
database is created too — the dashboard that flags if a data source goes down.)

> If something looks off (e.g., no patents show up), tell the assistant — most
> often the applicant name needs to match the patent office's spelling exactly
> (re-check it on Google Patents as above), and it'll help you adjust.
>
> If you hit an error right after creating an API key, give it a couple minutes
> and retry — new keys can take a few minutes to activate.
>
> If the assistant hits a **deploy** error mentioning Workers, a _capability_,
> or a **403** (e.g. `WorkersCapabilityMissing` or `CapabilityNotEnabledError`),
> Workers aren't fully enabled for your account. Have a **Workspace Owner**
> turn Workers on for the workspace (see Notion's
> [Workers help](https://www.notion.com/help/understand-pricing-for-workers)).
> Because this template _syncs_ data, the sync capability may also need
> to be enabled for your specific user during the beta — your Notion workspace
> admin can request that.

---

## Using your portfolio in Notion

### Families and applications (the nesting)

Your database has two kinds of rows:

- **Family rows** — a group of related applications (an original filing plus
  its continuations/divisionals, and its foreign counterparts once docketing is
  connected). These have **Type = Family**.
- **Application rows** — the individual patent applications and grants.

Each application is a **sub-item** of its family, so in the default view a
family row has a small triangle (▸) you can click to expand and reveal the
applications underneath it — like nested folders. This lets you see, at a
glance, how big each family is and what's in it.

### Recommended starter views

The worker manages your data and columns, not the layout — so it can't create
views for you. Set these up once in Notion (they survive every sync), or ask
your assistant to build them. Each is a few clicks: **+ Add view**, pick the
type, then set its **Filter**, **Sort**, and visible **Properties** from the
view's menus. Four that cover most needs:

- **Applications** — every individual filing, as a flat list.
  _Table._ Filter **Type is not Family**. Sort
  **Status Date** ↓. Show: Title, Jurisdiction, Type, App. No., Source, Filing
  Date, Status, Status Date, Grant Date, Patent #, Est. Expiry.
- **Patents** — only the applications that have granted.
  Duplicate **Applications**, then add the filter **Patent # is not empty** and
  sort **Grant Date** ↓.
- **Families** — one row per family, with its applications nested underneath.
  _Table._ Filter **Type is Family**. Sort **# Apps** ↓ (biggest first) or Title
  A→Z. Show: Title, # Apps, # Grants, Filing Date, Status, Est. Expiry (and
  Total Spend if you've connected spend). Click a family's ▸ to expand its apps.
- **Overview** — at-a-glance charts. Add **Chart** views (or chart widgets on a
  dashboard). Useful ones using only the default columns:
  - _Patents granted over time_ — Line; X = **Grant Date** by month; broken down
    by **Jurisdiction**; Count; filter **Patent # is not empty**.
  - _Granted patents by Type_ — Donut; group by **Type**; Count; filter
    **Patent # is not empty**.
  - _Applications by Jurisdiction_ — Donut; group by **Jurisdiction**; Count;
    filter **Type is not Family / Provisional**.
  - _Applications filed over time_ — Line; X = **Filing Date**; Count; same
    filter as above.
  - _Spend by family_ (only if spend is connected) — Bar; **Sum of Total
    Spend**; filter **Type is Family**.

### Make it your own (views, columns, properties)

The database is created **with a range of properties already populated** —
status, dates, grant/publication numbers, expiry estimates, family counts, and
more. That's intentionally a starting point, not a finished layout. Shape it to
how your team works directly in Notion — none of this affects syncing, and the
hourly refresh leaves your views and hidden columns alone:

- **Add more views** beyond the starters above — e.g. group by **Type** or
  **Jurisdiction**, sort by **Est. Expiry**, or filter to a single office.
  Build as many as you like and switch between them.
- **Hide properties you don't need.** Open a view's **Properties** menu and
  toggle off columns to declutter — the data stays, it's just out of sight.
- **Add your own properties** — a manual status flag, a priority rating, notes,
  an owner. The sync only writes the columns it manages and won't touch ones
  you add yourself.

> Want a property the sync should _populate_ (not a manual one), or want to
> remove a managed column entirely? That's a schema change — ask your assistant
> and run `/customize-schema`. See [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Optional: pair it with a custom agent

Because your portfolio is a live database, it makes a great foundation for a
**custom agent** — Notion's no-code automations that
read and act on your data on a schedule or when something changes. (The template
itself is a _worker_, which fills the database; agents are a separate, optional
layer on top.) Every agent is just three things: a **trigger** (when it runs),
**instructions** (what to do, in plain language), and **access** (what it can
see and touch). Start each on a **manual** trigger while you test, then turn on
the schedule once it behaves — agents consume Notion credits, so keep triggers
tight and grant the least access each one needs.

Three that pair well with the portfolio:

### Application Summarizer

Turns each filing into a one-line, plain-English summary the whole team can skim.

- **First, add a property:** create a text column called **Summary** on the
  Patent Portfolio database. (The sync never touches columns you add yourself.)
- **Trigger:** when a page is added to the database (a new application) — or run
  it manually to backfill rows whose Summary is empty.
- **Instructions:** _"For each application with an empty **Summary**, look up the
  patent by its **Patent #** or **Publication #** using web search and write a
  one- to two-sentence, plain-language summary of what it covers into the
  **Summary** property. If you can't find it confidently, leave Summary blank."_
- **Access:** read + edit the Patent Portfolio database; web access **on** (the
  office data the worker syncs has titles and status, not the full text, so the
  agent looks the patent up).

### Renewal & Expiry Watch

Surfaces upcoming deadlines so a renewal never slips — the highest-stakes job in
a portfolio.

- **Trigger:** scheduled, weekly.
- **Instructions:** _"In the Patent Portfolio database, find every row where
  **Est. Expiry** is within the next 6 months (or, if advanced enrichment is on,
  **Next Renewal Due** within 90 days), excluding rows whose **Status** is
  abandoned or expired. Post a digest grouped by **Jurisdiction**, each line
  showing Title, App. No. / Patent #, and the date. If nothing is due, say so."_
- **Access:** read the Patent Portfolio database; post to one Slack channel or a
  Notion page.

### New Grant Announcer

Celebrates and logs grants as they land.

- **Trigger:** event — _a property is updated_ on the database (it fires when the
  hourly sync sets a **Patent #** / **Grant Date**).
- **Instructions:** _"When a row's **Patent #** becomes non-empty, post to your
  IP channel: 'New grant — {Title}, {Patent #} ({Jurisdiction}), granted
  {Grant Date}.' Skip rows of Type **Family**, and don't announce a patent you've
  already posted."_
- **Access:** read the Patent Portfolio database; post to one Slack channel.

For the full how-to on building, sharing, and testing agents, see Notion's
[custom agents guide](https://www.notion.com/help/custom-agents).

---

## Going further

Once you're up and running, everything is customizable and extensible — and
your assistant can do it for you. These shortcuts are **Claude Code** commands;
in **Codex**, just ask for the same thing in plain language and it'll follow the
matching guide in `.claude/commands/`.

- `/connect-source` — connect your docketing or e-billing system, or add a new
  patent office (WIPO, JPO, a national register).
- `/customize-schema` — add, remove, or change the columns the sync manages.
- `/add-advanced-enrichment` — opt into richer fields (EP designated states,
  renewal payments, citations, INPADOC family IDs, US term/prosecution detail).

This template also ships two optional **document-retrieval** tools you can
invoke from your assistant: one lists a case's prosecution-history documents
(US, PCT/WO, or EP), the other fetches one as a full multi-page PDF and attaches
it under a Notion page. They run on demand (no extra sync load); `attach` needs
a `NOTION_API_TOKEN`. Ask your assistant to "list/attach prosecution documents,"
and see the `document-retrieval` skill for details.

For how it all works — the sources, the sync model and **hourly** cadence, the
resilience design, the manual quickstart, and an outage runbook — see
[`ARCHITECTURE.md`](ARCHITECTURE.md). Deeper design notes for your AI assistant
live in [`AGENTS.md`](AGENTS.md) and `.claude/skills/`.

New to Notion Workers in general? Notion's own docs are the source of truth:
[Run custom code with Workers](https://www.notion.com/help/run-custom-code-with-workers)
(Help Center) and the [developer docs](https://developers.notion.com).

## License

[MIT License](LICENSE).
