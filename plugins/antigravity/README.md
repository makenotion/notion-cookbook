# Notion plugin for Antigravity

Connects [Google Antigravity](https://antigravity.google/docs/plugins) to the
[Notion MCP server](https://developers.notion.com/docs/notion-mcp) and adds the
[MCP client skills](../../skills/mcp-clients/).

## Install

```sh
agy plugin install https://github.com/makenotion/notion-cookbook/tree/main/plugins/antigravity
```

The first Notion tool call opens a browser window to authorize your workspace.

## What's included

| File              | Purpose                                                   |
| ----------------- | --------------------------------------------------------- |
| `plugin.json`     | Antigravity manifest                                      |
| `mcp_config.json` | Notion MCP server at `https://mcp.notion.com/mcp` (OAuth) |
| `logo.svg`        | Plugin icon                                               |
| `skills/`         | Generated from `skills/mcp-clients/`. Do not edit.        |

## Maintain

Edit skills in [`skills/mcp-clients/`](../../skills/mcp-clients/), then run
`npm run plugins:build` from the repository root and commit the result. CI runs
`npm run plugins:check` and fails when `skills/` is out of date.

Check the plugin the way Antigravity loads it:

```sh
agy plugin validate plugins/antigravity --strict
```
