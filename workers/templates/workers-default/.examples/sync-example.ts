/**
 * Example: syncing projects and tasks from an external API to Notion.
 *
 * Demonstrates:
 * - Database declarations (hoisted from sync config)
 * - Pacers for rate limiting upstream API requests
 * - Relations between databases
 * - Backfill + delta sync pattern
 */

import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

const worker = new Worker()
export default worker

// -- Pacer: rate-limit requests to the upstream API --
// Research the API's rate limits and declare them here.
// If multiple syncs share a pacer, the budget is apportioned evenly.
const exampleApi = worker.pacer("exampleApi", {
  allowedRequests: 10, // 10 requests
  intervalMs: 1000, // per second
})

// -- Databases --

const projects = worker.database("projects", {
  type: "managed",
  initialTitle: "Projects",
  primaryKeyProperty: "Project ID",
  schema: {
    properties: {
      "Project Name": Schema.title(),
      "Project ID": Schema.richText(),
    },
  },
})

const tasks = worker.database("tasks", {
  type: "managed",
  initialTitle: "Tasks",
  primaryKeyProperty: "Task ID",
  schema: {
    properties: {
      "Task Name": Schema.title(),
      "Task ID": Schema.richText(),
      Status: Schema.select([
        { name: "Open", color: "blue" },
        { name: "In Progress", color: "yellow" },
        { name: "Done", color: "green" },
      ]),
      Project: Schema.relation("projectsSync", {
        twoWay: true,
        relatedPropertyName: "Tasks",
      }),
    },
  },
})

// -- Simple replace sync for projects (small dataset) --

worker.sync("projectsSync", {
  database: projects,
  mode: "replace",
  schedule: "1h",
  execute: async (state) => {
    const page = state?.page ?? 1
    await exampleApi.wait()
    const { items, hasMore } = await fetchProjects(page)

    return {
      changes: items.map((item) => ({
        type: "upsert" as const,
        key: item.id,
        properties: {
          "Project Name": Builder.title(item.name),
          "Project ID": Builder.richText(item.id),
        },
      })),
      hasMore,
      nextState: hasMore ? { page: page + 1 } : undefined,
    }
  },
})

// -- Backfill + delta sync pair for tasks --

// Backfill: paginates the full upstream dataset.
// Schedule: manual. To run:
//   ntn workers sync state reset tasksBackfill
//   ntn workers sync trigger tasksBackfill
// Replace mode: mark-and-sweep deletes records no longer upstream.
worker.sync("tasksBackfill", {
  database: tasks,
  mode: "replace",
  schedule: "manual",
  execute: async (state) => {
    const page = state?.page ?? 1
    await exampleApi.wait()
    const { items, hasMore } = await fetchAllTasks(page)

    return {
      changes: items.map((item) => ({
        type: "upsert" as const,
        key: item.id,
        properties: {
          "Task Name": Builder.title(item.name),
          "Task ID": Builder.richText(item.id),
          Status: Builder.select(item.status),
          Project: [Builder.relation(item.projectId)],
        },
      })),
      hasMore,
      nextState: hasMore ? { page: page + 1 } : undefined,
    }
  },
})

// Delta: fetches only recent changes.
// Schedule: runs every 5 minutes to keep Notion up to date.
// Incremental mode: only returns changes since the last cursor.
worker.sync("tasksDelta", {
  database: tasks,
  mode: "incremental",
  schedule: "5m",
  execute: async (state) => {
    const cursor = state?.cursor
    await exampleApi.wait()
    const { items, nextCursor } = await fetchTaskChanges(cursor)

    return {
      changes: items.map((item) => ({
        type: "upsert" as const,
        key: item.id,
        properties: {
          "Task Name": Builder.title(item.name),
          "Task ID": Builder.richText(item.id),
          Status: Builder.select(item.status),
          Project: [Builder.relation(item.projectId)],
        },
      })),
      hasMore: Boolean(nextCursor),
      nextState: nextCursor ? { cursor: nextCursor } : undefined,
    }
  },
})

// -- Placeholder functions (replace with real API calls) --

async function fetchProjects(_page: number) {
  return {
    items: [{ id: "proj-1", name: "Example Project" }],
    hasMore: false,
  }
}

async function fetchAllTasks(_page: number) {
  return {
    items: [
      {
        id: "task-1",
        name: "Write docs",
        status: "Open",
        projectId: "proj-1",
      },
    ],
    hasMore: false,
  }
}

async function fetchTaskChanges(_cursor: string | undefined) {
  return {
    items: [
      {
        id: "task-1",
        name: "Write docs",
        status: "Done",
        projectId: "proj-1",
      },
    ],
    nextCursor: null as string | null,
  }
}
