// Vendored from the Notion SDK's Notion-as-Code stub runtime
// (notion-sdk-js: src/EXPERIMENTAL__notion-as-code/utils/runtime.ts,
// createNotionAsCodeStubRuntime). Do not edit by hand; update it from the
// SDK when new intent helpers ship.
//
// Calls such as `notion.page()` record plain intent objects instead of
// calling the Notion API directly. `ntn notion-as-code apply` submits the
// recorded intents.

import type {
  DatabaseHandle,
  DatabaseIntent,
  DataSourceHandle,
  InfraAsCodeIntent,
  notion as notionDefinition,
  PageIntent,
  PropertySchemaDefinition,
} from "./types"

const intents: InfraAsCodeIntent[] = []

function recordIntent(intent: InfraAsCodeIntent) {
  intents.push(intent)
}

const notion: typeof notionDefinition = {
  space: (args) => {
    recordIntent({ type: "space", ...args })
    return {
      resourceId: args.resourceId,
      addTeamspace: (tsArgs) =>
        notion.teamspace({
          ...tsArgs,
          parent: { type: "resourceId", resourceId: args.resourceId },
        }),
    }
  },

  teamspace: (args) => {
    recordIntent({ type: "teamspace", ...args })
    return {
      resourceId: args.resourceId,
      addDatabase: (dbArgs) =>
        notion.database({
          ...dbArgs,
          parent: { type: "resourceId", resourceId: args.resourceId },
        }),
      addPage: (pageArgs) =>
        notion.page({
          ...pageArgs,
          parent: { type: "resourceId", resourceId: args.resourceId },
        }),
    }
  },

  database: <
    DS extends {
      resourceId: string
      name: string
      properties: PropertySchemaDefinition[]
    }[] = [],
  >(
    args: Omit<DatabaseIntent, "dataSources"> & { dataSources?: DS }
  ): DatabaseHandle<DS> => {
    const dataSourceInputs = args.dataSources ?? []
    recordIntent({ type: "database", ...args, dataSources: dataSourceInputs })

    const dataSources: Record<
      string,
      DataSourceHandle<PropertySchemaDefinition[]>
    > = {}
    for (const ds of dataSourceInputs) {
      const dataSourceResourceId = ds.resourceId
      dataSources[ds.resourceId] = {
        resourceId: dataSourceResourceId,
        schema: ds.properties,
        addPage: (pageArgs) =>
          notion.page({
            ...pageArgs,
            parent: {
              type: "resourceId",
              resourceId: dataSourceResourceId,
            },
          }),
      }
    }

    return {
      resourceId: args.resourceId,
      dataSources,
      getDataSource: (id) => {
        const dataSource = dataSources[id]
        if (dataSource === undefined) {
          throw new Error(`Unknown data source resourceId: ${id}`)
        }

        return dataSource
      },
      addView: (view) => {
        recordIntent({
          type: "view",
          databaseResourceId: args.resourceId,
          view,
        })
      },
    } as DatabaseHandle<DS>
  },

  page: (args) => {
    recordIntent({ type: "page", ...args })
    return {
      resourceId: args.resourceId,
      addPage: (pageArgs: Omit<PageIntent, "parent">) =>
        notion.page({
          ...pageArgs,
          parent: { type: "resourceId", resourceId: args.resourceId },
        }),
      addDatabase: (dbArgs: Omit<DatabaseIntent, "parent">) =>
        notion.database({
          ...dbArgs,
          parent: { type: "resourceId", resourceId: args.resourceId },
        }),
    }
  },

  customAgent: (args) => {
    recordIntent({ type: "custom_agent", ...args })
    return {
      resourceId: args.resourceId,
    }
  },

  // Creates a file reference for use in database file properties. The
  // resourceId must match a file from the file manifest.
  file: (resourceId) => ({ type: "file", resourceId }),

  text: (value) => [[value]],
  number: (value) => [[String(value)]],
  checkbox: (value) => [[value ? "Yes" : "No"]],
  phone: (value) => [[value]],
  select: (value) => value,
  status: (value) => value,
  multiSelect: (values) => values.join(","),
  date: (startDate, endDate) => {
    const start_date = parseISODate(startDate)
    const end_date = endDate === undefined ? undefined : parseISODate(endDate)
    if (end_date !== undefined && end_date < start_date) {
      throw new Error("Date range end must be on or after start.")
    }
    const dateData = end_date
      ? { type: "daterange", start_date, end_date }
      : { type: "date", start_date }
    return [["\u2023", [["d", dateData]]]]
  },
  datetime: (value) => {
    const timeZone = value.timeZone ?? "UTC"
    if (!isTimeZoneValid(timeZone)) {
      throw new Error(
        `Invalid time zone: ${timeZone}. Expected an IANA time zone like America/New_York`
      )
    }
    const start = parseISODateTime(value.start)
    const end =
      value.end === undefined ? undefined : parseISODateTime(value.end)
    if (
      end !== undefined &&
      `${end.date}T${end.time}` < `${start.date}T${start.time}`
    ) {
      throw new Error("Datetime range end must be on or after start.")
    }
    const dateData = end
      ? {
          type: "datetimerange",
          start_date: start.date,
          start_time: start.time,
          end_date: end.date,
          end_time: end.time,
          time_zone: timeZone,
        }
      : {
          type: "datetime",
          start_date: start.date,
          start_time: start.time,
          time_zone: timeZone,
        }
    return [["\u2023", [["d", dateData]]]]
  },
  verification: (value) => ({ type: "verification", ...value }),
  url: (value) => [[value, [["a", value]]]],
  email: (value) => [[value, [["a", `mailto:${value}`]]]],
  relation: (value) => value,
}

function parseISODate(dateString: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString)
  if (!match) {
    throw new Error(
      `Invalid ISO 8601 date: ${dateString}. Expected format like 2024-01-15`
    )
  }
  if (
    !isValidCalendarDate(match) ||
    Number.isNaN(new Date(dateString).getTime())
  ) {
    throw new Error(`Invalid date: ${dateString}`)
  }
  return dateString
}

function parseISODateTime(isoString: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(isoString)
  if (!match) {
    throw new Error(
      `Invalid ISO 8601 datetime: ${isoString}. Expected format like 2024-01-15T10:30 or 2024-01-15T10:30:00Z`
    )
  }
  if (
    !isValidCalendarDate(match) ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number.isNaN(new Date(isoString).getTime())
  ) {
    throw new Error(`Invalid datetime: ${isoString}`)
  }
  return { date: match[0].slice(0, 10), time: match[0].slice(11, 16) }
}

function isValidCalendarDate(match: RegExpExecArray) {
  const [year, month, day] = match.slice(1, 4).map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function isTimeZoneValid(timeZone: string) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone })
    return true
  } catch (error) {
    if (error instanceof RangeError) {
      return false
    }
    throw error
  }
}

export type * from "./types"
export { notion }

/** Internal: consumed by entry.ts after the user script has run. */
export function getIntents() {
  return intents
}
