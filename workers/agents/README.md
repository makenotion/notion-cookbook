# Canonical worker agent files

This directory is the single source of truth for the agent files that worker
templates ship in their `.agents/` directory.

| Path                          | Holds                                                    |
| ----------------------------- | -------------------------------------------------------- |
| `instructions/default/`       | instructions for every `worker-` recipe with no override |
| `instructions/custom-blocks/` | instructions for `kind: "worker-custom-block"`           |
| `instructions/workflow/`      | instructions for `kind: "worker-workflow"`               |
| `skills/`                     | every skill, whether or not a given template ships it    |

## Groups

Each `catalog.json` recipe with a `worker-` kind resolves to one group. A group
is one set of instructions plus the skills that ship with them. `DEFAULT_GROUP`
applies unless the kind appears in `OVERRIDE_GROUPS`, in which case that kind
gets a different set instead.

```js
const DEFAULT_GROUP = {
  skillsRoot: WORKER_SKILLS_ROOT,
  instructions: `${INSTRUCTIONS_ROOT}/default`,
  skills: DEFAULT_SKILLS,
}

const OVERRIDE_GROUPS = {
  "worker-custom-block": {
    skillsRoot: WORKER_SKILLS_ROOT,
    instructions: `${INSTRUCTIONS_ROOT}/custom-blocks`,
    skills: [...DEFAULT_SKILLS, "custom-blocks"],
  },
  "worker-workflow": {
    skillsRoot: WORKER_SKILLS_ROOT,
    instructions: `${INSTRUCTIONS_ROOT}/workflow`,
    skills: ["workflow", "workflow-guide", "workflow-validate"],
  },
}
```

`skills` names entries in `skills/`, so a template ships only the ones its group
lists. Spread `DEFAULT_SKILLS` to add to them instead of repeating them.

App recipes use their own group and [canonical App guidance](../../apps/agents/).
`skillsRoot` keeps each group's skill names scoped to its SDK family.

Each template also gets an `AGENTS.md` and a `CLAUDE.md` symlink pointing at
`.agents/INSTRUCTIONS.md`, so both discovery conventions resolve to one file.

## Editing agent files

1. Edit the files here — never the per-template copies under
   `workers/templates/*/.agents/`. Those copies are generated.
2. Run `npm run agents:sync` (the pre-commit hook also runs it) to regenerate
   the per-template copies.
3. Commit the canonical change and the regenerated copies.

The sync deletes each template's `.agents/` and copies the set back, so a
renamed or removed canonical file leaves nothing behind.

CI enforces that all worker templates have the latest versions of these files
copied with no differences.

## Adding a skill

Add a directory under `skills/`, then name it in `DEFAULT_SKILLS` or in one
group's `skills`.

## Adding an override

Add a directory under `instructions/`, then map a `catalog.json` kind to it in
`OVERRIDE_GROUPS`.

## SDK-owned custom blocks skill

The Workers SDK owns the full custom blocks skill.
The template includes a loader at `skills/custom-blocks/SKILL.md`.
The loader directs agents to `node_modules/@notionhq/workers/skills/custom-blocks/SKILL.md` in the Worker project.
Keep the loader metadata here for skill discovery.
Change the full instructions in the Workers SDK repository.

For existing projects, update `@notionhq/workers` to a release that includes the skill.
Replace the project’s `.agents/skills/custom-blocks/SKILL.md` with this repository’s loader.
Later SDK updates also update the full skill.
