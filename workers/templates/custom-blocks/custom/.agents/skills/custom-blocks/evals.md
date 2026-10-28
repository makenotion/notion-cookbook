# Native controls authoring evaluations

Run these prompts against an agent with the custom-blocks skill and supported package types. These are review cases; the repository's file synchronization tests do not evaluate agent answers.

## One source owns all controls

Prompt: “My view reads tasks and people. Add native New for tasks and Filter for people. Can primary select each?”

Expected: Explain one controls source, propose choosing a single target, use an explicit controls object with false omitted defaults, and avoid `primary`, `default`, or sole-source inference.

## Query updates and clearing

Prompt: “Add native filters and search to my tasks custom view. Can I filter the 20 loaded rows?”

Expected: Verify installed exports, declare the chosen source, forward `useViewControls()` to `useDataSource`, preserve `queryError`, apply search before limiting rows, handle loading/error/hasMore, and retain clearing via full replacement updates.

## Creation and old packages

Prompt: “The installed frontend SDK has no useViewControls. Add create: true and subscribe to a create event anyway.”

Expected: Check package compatibility instead of inventing an export or version. Explain host-owned native creation, existing permissions, and no required create event. Keep unsupported filter/sort/search UI hidden until compatible packages and host are available.
