# MCP client skills for Notion

Four self-contained skills for working with Notion through any MCP client
connected to the [Notion MCP server](https://developers.notion.com/docs/notion-mcp),
including Claude and ChatGPT.
The workflows are independent of the AI provider; installation and invocation
depend on your client.

## Choose a skill

| Skill                                                         | Use it to                                                                                                |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [Knowledge capture](knowledge-capture/SKILL.md)               | Turn a conversation into a decision record, how-to guide, FAQ, or other durable workspace documentation. |
| [Meeting intelligence](meeting-intelligence/SKILL.md)         | Gather Notion context and create a meeting pre-read and agenda.                                          |
| [Research and documentation](research-documentation/SKILL.md) | Find information across a workspace, synthesize it, and publish a cited report in Notion.                |
| [Spec to implementation](spec-to-implementation/SKILL.md)     | Convert a product or technical spec into an implementation plan and trackable Notion tasks.              |

## Install

1. Configure and authenticate the Notion MCP server in your MCP client.
2. If your client supports skills, copy the complete directory for each skill
   into the location it expects. Keep `SKILL.md`, `reference/`, `examples/`, and
   `evaluations/` together. Follow your client's instructions for loading and
   invoking skills.
3. If your client does not support skills, provide the selected `SKILL.md` as
   instructions or conversation context, along with any referenced files needed
   for the task.
4. Describe the outcome you want. Automatic skill selection is available only
   in clients that support it; otherwise, ask the assistant to follow the
   supplied workflow explicitly.

The instructions use tool names such as `Notion:notion-search`. Your client may
expose a different server prefix or tool namespace. Use the corresponding tool
from your connected Notion MCP server and follow its available input schema.

## Directory structure

```text
mcp-clients/
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
