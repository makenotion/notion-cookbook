import { Worker } from "@notionhq/workers"

import { fetchRows } from "./duckdb.js"
import { INITIAL_TITLE, PRIMARY_KEY, customerSchema } from "./schema.js"
import { customerToChange, type CustomerRow } from "./transform.js"

const worker = new Worker()

const database = worker.database("customers", {
  type: "managed",
  initialTitle: INITIAL_TITLE,
  primaryKeyProperty: PRIMARY_KEY,
  schema: customerSchema,
})

worker.sync("customersSync", {
  database,
  mode: "replace",
  schedule: "manual",
  execute: async () => {
    const rows = await fetchRows(
      "SELECT id, name, email, country, signup_date FROM customers ORDER BY id"
    )
    return {
      changes: rows.map((row) => customerToChange(row as CustomerRow)),
      hasMore: false,
    }
  },
})

export default worker
