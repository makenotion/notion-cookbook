# Native custom view controls

This contract requires Worker declarations with `controls`, a frontend SDK with `useViewControls`, and a Notion host that supports the corresponding capability. Check the installed types and package documentation before using it. Do not add unsupported fields or invent a future package version. Keep this guidance behind the package and host rollout.

## Choose one source

Opt in on the data source whose database contains the custom view:

```ts
dataSources: {
  tasks: {
    name: "Tasks",
    controls: { create: true, filter: true, sort: true, search: true },
    properties: {
      title: { name: "Name", type: "title" },
    },
  },
  people: { name: "People" },
}
```

At most one source may declare `controls`, including an empty object. Each omitted flag is false. A sole source has no implicit controls. Use the object form; `primary`, `default`, and `controls: true` do not select a source. New, Filter, Sort, and Search all target that one source. A mismatched database binding hides native controls.

## Forward query state

```tsx
import { useDataSource, useViewControls } from "@notionhq/custom-blocks/react"

function useTasks() {
  const controls = useViewControls()
  return useDataSource("tasks", { ...controls, limit: 100 })
}
```

Render the returned loading and error states, and show incomplete results when `hasMore` is true.

The initial native state arrives during initialization. Every change replaces the full state; clearing a control removes its old query setting. `useViewControls()` subscribes to those changes. Imperative code uses `customBlock.getViewControls()` and `customBlock.subscribeToViewControls(listener)` and unsubscribes when disposed.

Forward the state only to the selected source. Other queries remain independent. Spread it before `limit`, as above. When combining author conditions, combine the filters explicitly with `and`; do not overwrite the native filter or discard `queryError`. Unsupported native conditions produce a query error rather than unfiltered results. Property conditions use resolved IDs; author-written conditions may use semantic keys. Compound filters support three group levels and 25 children per group.

The host applies filters, sorts, and search before limiting results. The default query limit is 20 and the maximum is 999. Search is a plain-text database query, not a filter over already-loaded rows. Filter/sort and search have separate SDK capabilities so old sandboxes keep unsupported controls hidden.

## Create a page

`create: true` enables the host's native New action, subject to existing permissions. The host owns page creation, templates, and navigation. There is no create event to forward and no required SDK handler. Continue using the SDK's page API when the custom UI needs its own creation workflow.

## Verify a view

Use the development shell's view query simulator to apply and clear query state, and confirm the custom query changes. The simulator accepts raw property IDs. Its search approximates string and number fixture values; verify native property search in Notion before claiming parity.

In Notion, check no opt-in, each enabled control, two-source ownership, mismatched bindings, read-only creation, unsupported filters, clearing controls, and an older SDK. Use a result beyond the first page to verify search runs before the limit. Report any live checks that were not run.
