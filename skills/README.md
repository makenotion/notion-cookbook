# Skills

AI-powered workflows that make it easier to work with Notion.

## What are skills?

Skills are structured instructions that help AI assistants perform complex tasks in Notion. They combine multiple API calls and decision-making logic into reusable workflows.

## Available skills

### MCP client skills

The [mcp-clients](mcp-clients/) directory contains reusable workflows for any MCP client connected to the Notion MCP server, including Claude and ChatGPT. Skill loading varies by client; you can install them as skills or provide the instructions as context.

- **[database-designer](mcp-clients/database-designer/)**: Turn scattered notes into useful trackers for requests, content plans, and team work
- **[weekly-project-digest](mcp-clients/weekly-project-digest/)**: Compare reporting periods and produce evidence-based project updates
- **[knowledge-capture](mcp-clients/knowledge-capture/)**: Transform conversations and discussions into structured documentation
- **[meeting-intelligence](mcp-clients/meeting-intelligence/)**: Prepare for meetings by gathering context and creating agendas
- **[research-documentation](mcp-clients/research-documentation/)**: Research topics and document findings in Notion
- **[spec-to-implementation](mcp-clients/spec-to-implementation/)**: Parse specifications and create implementation plans with task tracking

## Using skills

1. Connect your MCP client to the [Notion MCP server](https://developers.notion.com/docs/notion-mcp).
2. Install the complete skill directory using your client's skill support, or provide its `SKILL.md` and any referenced files as context.
3. Describe the outcome you want and invoke the skill using your client's supported workflow.

See the [MCP client skills README](mcp-clients/README.md) for detailed setup instructions.

## Contributing skills

Want to add a skill? Check out [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.

Skills should:

- Solve a specific, common workflow
- Include evaluations that test effectiveness
- Be well documented with clear examples
- Keep workflow instructions independent of a specific AI provider or MCP client
