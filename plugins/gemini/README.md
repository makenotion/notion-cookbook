# Notion extension for Gemini CLI

Connects [Gemini CLI](https://geminicli.com/docs/extensions/) to the
[Notion MCP server](https://developers.notion.com/docs/notion-mcp) and adds the
[MCP client skills](../../skills/mcp-clients/).

## Install

Gemini CLI installs GitHub extensions only from a repository root, so install
this one from a local checkout:

```sh
git clone https://github.com/makenotion/notion-cookbook
gemini extensions install ./notion-cookbook/plugins/gemini
```

Then run `/mcp auth notion` in Gemini CLI to authorize your workspace.

## What's included

| File                    | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `gemini-extension.json` | Manifest and Notion MCP server at `https://mcp.notion.com/mcp` |
| `skills/`               | Generated from `skills/mcp-clients/`. Do not edit.             |

## Maintain

Edit skills in [`skills/mcp-clients/`](../../skills/mcp-clients/), then run
`npm run plugins:build` from the repository root and commit the result. CI runs
`npm run plugins:check` and fails when `skills/` is out of date.

Check the extension the way Gemini CLI loads it:

```sh
gemini extensions validate plugins/gemini
```
