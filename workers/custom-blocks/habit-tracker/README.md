# Worker custom block: Habit tracker

**TL;DR:** A month-at-a-glance habit grid rendered inside a Notion page.
Habits run down the left with streaks; days run across the top; checking a dot
creates a row in a Habits Log database, so history stays in plain Notion data.

## Quickstart

From the repository root:

```zsh
npm install --global ntn
cd workers/custom-blocks/habit-tracker
npm install
npm run check
npm test
ntn login
ntn workers deploy --name habit-tracker
```

In Notion, insert the custom block into a page and map both data sources. The
block renders a sample month and a setup hint until they are bound.

## Databases

Two data sources:

`habits` ("Habits") — one row per habit:

| Property | Type      | Meaning                                                              |
| -------- | --------- | -------------------------------------------------------------------- |
| `name`   | title     | Habit name                                                           |
| `icon`   | rich_text | An emoji shown next to the name                                      |
| `color`  | select    | `yellow`, `blue`, `pink`, `green`, `purple`, `red`, `orange`, `teal` |

`log` ("Habits Log") — one row per completed habit-day:

| Property | Type     | Meaning                                     |
| -------- | -------- | ------------------------------------------- |
| `name`   | title    | Written as `{habit} — {YYYY-MM-DD}`         |
| `date`   | date     | The completed day                           |
| `habit`  | relation | The habit (relation to the Habits database) |

A log row's existence marks that habit complete for that day. Toggling a dot
on creates a row; toggling off archives every matching row (duplicates are
deduplicated on render). Writes are optimistic with quiet inline errors and
reverts on failure. Day keys are derived from local calendar dates, so
completions never shift across timezones.

## The grid

Today's column is banded and its day number chipped; completing every habit on
a day tints the chip. Streaks count consecutive days ending today (or
yesterday if today is untouched) and walk back across month boundaries — when
older data falls outside the loaded window the streak shows as `12+` rather
than guessing. Future days are visible but disabled; past months stay
toggleable. The grid is fully keyboard-navigable (arrow keys move, Space or
Enter toggles), and the habit column stays sticky while the days scroll on
narrow blocks. The iframe automatically grows with the habit list, so longer
trackers stay in the page's scroll flow instead of opening a nested vertical
scroller.

## Local development

The view renders standalone with seeded sample data, no Notion host required:

```zsh
cd blocks/habit-tracker
npx vite
```

Open `http://localhost:5173/?mock=1`. Harness parameters: `theme=dark`,
`empty`, `unbound`, `loading`, `many` (16 habits), and `failwrites` (exercises
revert paths).

## Project structure

```text
src/
  index.ts       Worker definition and both data-source schemas
blocks/habit-tracker/
  src/
    App.tsx      Store-state switch and setup shell
    components/Tracker.tsx   Month grid, header, streaks, keyboard navigation
    dates.ts     Local-date keys, month math, streak counting
    notionStore.ts / mockStore.ts   Real and mock data layers
```

## Limitations

- The log query loads up to 999 rows; very long histories truncate streak
  lookback (shown as `N+`).
- Milestone effects were intentionally removed — the only motion is a 150ms
  fill-in on check, per Notion's motion register.
