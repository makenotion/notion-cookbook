# Canonical worker agent files

This directory is the single source of truth for the agent files that worker
templates ship. Most land in a template's `.agents/` directory. The files in
`root-files/` land at the template root instead.

| Path                          | Holds                                                    |
| ----------------------------- | -------------------------------------------------------- |
| `instructions/default/`       | instructions for every `worker-` recipe with no override |
| `instructions/custom-blocks/` | instructions for `kind: "worker-custom-block"`           |
| `skills/`                     | every skill, whether or not a given template ships it    |
| `root-files/`                 | files copied to every template root, whatever its group  |

## Groups

Each `catalog.json` recipe with a `worker-` kind resolves to one group. A group
is one set of instructions plus the skills that ship with them. `DEFAULT_GROUP`
applies unless the kind appears in `OVERRIDE_GROUPS`, in which case that kind
gets a different set instead.

```js
const DEFAULT_GROUP = {
  instructions: `${INSTRUCTIONS_ROOT}/default`,
  skills: DEFAULT_SKILLS,
}

const OVERRIDE_GROUPS = {
  "worker-custom-block": {
    instructions: `${INSTRUCTIONS_ROOT}/custom-blocks`,
    skills: [...DEFAULT_SKILLS, "custom-blocks"],
  },
}
```

`skills` names entries in `skills/`, so a template ships only the ones its group
lists. Spread `DEFAULT_SKILLS` to add to them instead of repeating them.

Each template also gets an `AGENTS.md` and a `CLAUDE.md` symlink pointing at
`.agents/INSTRUCTIONS.md`, so both discovery conventions resolve to one file.

## Root files

`root-files/` holds files that land at the template root, not in `.agents/`.
Every worker template gets all of them. A group cannot opt out.

Today the directory holds `.claudeignore` and `.codexignore`. Both are copied
byte for byte from `makenotion/workers-template`, so a template scaffolded from
either source looks the same.

Neither file is enforced today. Claude Code has no `.claudeignore` feature, and
Codex has no `.codexignore` feature. Both tools gate file reads through their
permission settings instead. Treat these two files as a statement of intent, not
as protection for a developer's `.env`.

The sync never deletes the template root. A file removed from `root-files/`
therefore leaves its per-template copies behind. Delete those copies in the
same commit.

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
