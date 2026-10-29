# Design for a useful, beautiful starting point

Read this before composing or polishing the output. Treat the layouts as starting
points; adapt them to the user's content and supported Notion features.

## Gallery observations

Inspected gallery preview images and visible creator labels on October 29, 2026.
This is a deliberately varied sample, not an audit of the entire gallery or proof
that every interaction in the underlying templates works.

| Template and creator                                                                                     | Visible design pattern                                                             | Adaptation worth borrowing                                                                                           |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [Brand Guidelines — Notion](https://www.notion.com/templates/brand-guidelines)                           | Small purple bookmark icon, clear introduction, section headings and dividers.     | Establish a quiet hierarchy and explain how to use the page before detailed reference material.                      |
| [Brand Assets — Notion](https://www.notion.com/templates/brand-assets)                                   | Large asset previews, short labels, category view tabs, and a brief usage hint.    | Use imagery when users recognize items visually; give views meaningful names and show only useful metadata.          |
| [Team home — Notion](https://www.notion.com/templates/team-home-v4)                                      | Office-photo cover, home icon, team overview and a concise mission statement.      | Give the home an identity and purpose before organizational detail.                                                  |
| [Brand Guide — Matt Bio](https://www.notion.com/templates/brand-guide-bio)                               | High-contrast typographic cover, compact index, and coordinated green logo panels. | Carry a coherent palette through supplied assets and navigation; use an index for long reference pages.              |
| [Notion Engineering Dashboard — Matt Bio](https://www.notion.com/templates/notion-engineering-dashboard) | Gradient cover, prominent action row, schedule with week/month tabs.               | Put frequent actions within reach and offer focused views rather than exposing everything at once.                   |
| [Student dashboard — Janice Studies](https://www.notion.com/templates/student-dashboard)                 | Soft photographic cover, playful icon, and a personal widget row.                  | Personal style can make a workspace inviting; retain warmth while giving actual academic work priority over widgets. |
| [Projects & Tasks — Notion](https://www.notion.com/templates/notion-projects-and-tasks)                  | Short explanatory intro, named view tabs, grouped tasks, and labeled status chips. | Pair orientation with a usable work surface; adapt the visible property count to the user's task.                    |

These are observations of previews; the implementation choices below are our
recommendations. Borrow composition and interaction patterns, not the creators'
artwork, example brands, paid content, or invented data. Record the actual creator
when citing a reference. Community and Notion-created templates are both eligible
unless the user explicitly narrows the source set.

## Compose an EPD project home

Use the full research as the quality benchmark, selecting patterns appropriate
for a working product team: the connected work and named views in Projects &
Tasks, the hierarchy in Brand Guidelines, and the orientation in Team home.
A student dashboard's playfulness or a brand campaign's visual treatment is not
a default for an EPD project.

- Start with the actual project name and one sentence about the user problem.
  Show stage, known leads, and agreed target in a compact metadata area. Use
  ordinary labels such as Overview, Tasks, Docs, and Decisions.
- Keep the overview brief: intended outcome, scope boundaries, and the current
  risk or decision. Link the product brief for details. Do not repeat the same
  summary in several panels.
- Give Tasks and Docs equal structural importance. Place a compact, populated
  task table and docs list/table on the home. Keep alternate status and review
  views in tabs on those collections. Do not turn every collection into a board.
- Put detailed requirements, design states, tradeoffs, decisions, and rollout
  criteria inside the relevant documents. Tasks link to their specifications;
  readers can return to the project home from either kind of record.
- Use restrained typography, whitespace, alignment, and consistent view settings
  for polish. Color should communicate state or draw attention to a real risk.
  Avoid promotional taglines, decorative phase cards, motivational copy, rainbow
  panels, and repeated emoji headings. A cover is optional, not the design.
- Include milestones only when they represent real project commitments. Do not
  invent a phase sequence to fill the page. Put detailed sequencing in tasks or
  the rollout doc instead of adding another home-page module.

The settled home is the body of a record in the chosen Projects database; the
initial version can be a private draft while placement is unresolved. Surface
existing project properties instead of duplicating editable status and ownership
in body text. Once placement is known, filter Tasks and Docs views to that project
relation. Keep team context compact: names, responsibilities, and relevant
review roles. Add it from known context or the user's post-delivery answers,
without an empty roster or fabricated assignments.

Default EPD composition: overview and metadata → current decision if needed →
Tasks → Docs → Meeting notes. Keep meeting notes to a compact recent-notes view
and a clear next-agenda entry; do not expand the full agenda on the home. Adapt to the team's context; a personal checklist or event brief
can remain smaller. Serious does not mean bare: useful content, connected records,
clear states, and carefully chosen density supply the visual character.

## Keep the delivery workspace focused

Compose this project independently of sibling demo skills. Its working task and
document views, team context, and meeting notes supply its structure. Do not add
course cards, an editorial masthead, or a service directory just to share visual
patterns with other skills. The initial private draft is independent; after the
user chooses a Projects database it becomes a record there. An optional demo index
links to the home without imposing a common scaffold.

Choose page settings for dense team work when supported. Keep the overview short
enough that work is visible without scrolling through a long introduction. Use
compact properties and view tabs rather than many colored summary panels.

## Build a finished artifact

Create the real destinations and records, then compose the home around their
actual URLs and views. When inline views are supported, put the primary work
surface in the home; a full-page database link alone is not equivalent. Move the
view into its intended position if the tool initially appends it. Keep source
briefs and evaluation notes behind a secondary link or collapsed section so they
do not dominate the product experience.

No “notes will live here,” future-tense descriptions of missing features, fake
buttons, empty titled subpages, or views that have only been named but not
configured. With genuinely sparse input, deliver a smaller completed artifact:
useful capture prompts and honest empty states are acceptable. Do not manufacture
facts. When the user requests a demo, use explicitly labeled mock inputs as the
source; do not misrepresent them as real work or assign real people.

Explain how to use an unfamiliar view or section in one practical sentence next
to it. Distinguish editable prompts from committed tasks and static summaries
from live data. Avoid duplicating the same tasks as independent checklists and
database records without explaining which is authoritative.

## Compare the result with the research

Review the artifact itself, not its Markdown source or the final response:

- **Distinctive composition:** does the arrangement fit this use case, and can
  you identify useful reference patterns in the rendered result? Changing the
  title and emoji on the same generic page does not pass.
- **Visual coherence:** do color, typography, icons, imagery, and spacing feel
  intentional across the home and child pages? Plain can be polished; random
  decoration and bare boilerplate both fail.
- **Immediate utility:** can a new user start doing the work from this page?
  Check a real item, its detail, and the return path. Verify supported action
  configuration without triggering unrelated writes.
- **Depth and fidelity:** are records populated with the supplied context and
  useful structure, while preserving uncertainty, blockers, and provenance?
- **Usability:** inspect the main surface on desktop and at a narrow width when
  rendering is available. Check for clipping, stranded headings, confusing
  reading order, excessive empty space, and missing undated work.

Revise a failed result before presenting it as finished. If rendering is
unavailable, distinguish structural validation from unperformed visual inspection.
Do not claim visual quality was verified by frontmatter, lint, or schema checks.
The full template research is the quality benchmark, including both Notion and
community references. Select the patterns that suit this user and workflow; no
single template or recorded example defines the standard. Evaluate the result
against the research as a whole, rather than counting matching blocks or copying
one example. An ordinary setup request must receive this quality without extra
design coaching from the user.
