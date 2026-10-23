---
name: notion-setup
description: Sets up Notion as durable, shared context for the agent by following the official Notion setup guide. Use right after the Notion plugin or Notion MCP server is installed, when the user chooses Set up for Notion, or when they ask to get set up with Notion. Do not use for ordinary Notion tasks.
---

# Set up Notion

Help the user get set up with the Notion MCP by following the official setup
guide at <https://developers.notion.com/prompts/setup>.

1. **Confirm the connection.** Make one read-only Notion MCP call, such as a
   short search. If it fails with an authentication or permission error, ask
   the user to connect or reconnect Notion, then stop.
2. **Read the guide.** Fetch <https://developers.notion.com/prompts/setup> and
   read all of it. If you cannot fetch web pages, ask the user to open the link
   and paste its contents. Do not reconstruct the guide from memory.
3. **Follow it.** Work through the guide's setup steps with the user. Respect
   its approval rules: inspect before changing anything, propose specific
   imports and schemas, and wait for approval before writing to Notion.
4. **Continue the user's task.** If the plugin was installed in the middle of
   another task, finish setup only as far as the user wants, then return to that
   task.

The guide is versioned and maintained by Notion. Follow the current published
version rather than any earlier copy.
