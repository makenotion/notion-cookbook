import { database } from "@notionhq/apps"

export const STATUS = {
  pending: "pending",
  adding: "adding",
  invalid: "invalid",
  success: "success",
  fail: "fail",
} as const

export type Status = (typeof STATUS)[keyof typeof STATUS]

export const rollout = database("rollout-db", {
  dataSourceResourceId: "rollout-source",
  name: "Rollout",
  schema: {
    ID: { resourceId: "rollout-id", type: "title" },
    Status: {
      resourceId: "rollout-status",
      type: "status",
      options: {
        todo: [{ name: STATUS.pending, color: "gray", default: true }],
        inProgress: [{ name: STATUS.adding, color: "blue" }],
        complete: [
          { name: STATUS.success, color: "green" },
          { name: STATUS.invalid, color: "orange" },
          { name: STATUS.fail, color: "red" },
        ],
      },
    },
    Error: { resourceId: "rollout-error", type: "text" },
  },
})

export const rolloutTable = rollout.addView({
  resourceId: "rollout-table",
  name: "All IDs",
  type: "table",
  dataSourceResourceId: "rollout-source",
  properties: [
    { property: "rollout-id", visible: true },
    { property: "rollout-status", visible: true },
    { property: "rollout-error", visible: true },
  ],
})
