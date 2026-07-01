# Claude skills for Notion MCP

Four self-contained skills for working with Notion through Claude and the
[Notion MCP server](https://developers.notion.com/docs/notion-mcp).

## Choose a skill

| Skill                                                         | Use it to                                                                                                |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [Knowledge capture](knowledge-capture/SKILL.md)               | Turn a conversation into a decision record, how-to guide, FAQ, or other durable workspace documentation. |
| [Meeting intelligence](meeting-intelligence/SKILL.md)         | Gather Notion context and create a meeting pre-read and agenda.                                          |
| [Research and documentation](research-documentation/SKILL.md) | Find information across a workspace, synthesize it, and publish a cited report in Notion.                |
| [Spec to implementation](spec-to-implementation/SKILL.md)     | Convert a product or technical spec into an implementation plan and trackable Notion tasks.              |

## Install

1. Configure the Notion MCP server in Claude.
2. Copy the complete directory for each skill you want into the skills directory
   used by Claude. Keep `SKILL.md`, `reference/`, `examples/`, and `evaluations/`
   together. For example, from this repository's root, install one user-level
   Claude Code skill with:

   ```sh
   mkdir -p ~/.claude/skills
   cp -R skills/claude/knowledge-capture ~/.claude/skills/
   ```

3. Start a new Claude session and describe the outcome you want. Claude selects
   a relevant installed skill from its `name` and `description` metadata.

## Directory structure

```text
claude/
├── knowledge-capture/
├── meeting-intelligence/
├── research-documentation/
└── spec-to-implementation/

<each-skill>/
├── SKILL.md       # Entry point and workflow instructions
├── reference/     # Detailed guidance loaded when needed
├── examples/      # Worked examples
└── evaluations/   # Evaluation scenarios and instructions
```

## For agents and contributors

- Read the selected `SKILL.md` first and resolve its links relative to that
  skill directory.
- Load only the referenced guidance or examples needed for the current task.
- Treat `evaluations/` as validation material, not runtime instructions.
- When changing a skill, update its evaluations and follow the repository
  [contributing guide](../../CONTRIBUTING.md).
