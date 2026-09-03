/**
 * Replace mode — static data, no pagination.
 *
 * The simplest possible sync. Returns hardcoded data with no API calls.
 * Good for: testing the sync setup, syncing small static datasets.
 *
 * Key points:
 * - mode: "replace" means the runtime deletes any records not returned each cycle
 * - No state needed — there's no pagination and no cursor
 * - hasMore: false on every call — single-page cycle
 * - Database is declared separately via worker.database() and referenced by handle
 */

import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

const worker = new Worker()
export default worker

const teamDb = worker.database("teamDb", {
  type: "managed",
  initialTitle: "Team Members",
  primaryKeyProperty: "Member ID",
  schema: {
    properties: {
      Name: Schema.title(),
      "Member ID": Schema.richText(),
    },
  },
})

worker.sync("teamSync", {
  database: teamDb,
  mode: "replace",
  execute: async () => {
    // In a real sync, you'd fetch this from an API
    const members = [
      { id: "m-1", name: "Alice" },
      { id: "m-2", name: "Bob" },
      { id: "m-3", name: "Charlie" },
    ]

    return {
      changes: members.map((m) => ({
        type: "upsert" as const,
        key: m.id,
        properties: {
          Name: Builder.title(m.name),
          "Member ID": Builder.richText(m.id),
        },
      })),
      // No more pages — cycle is complete
      hasMore: false,
    }
  },
})
