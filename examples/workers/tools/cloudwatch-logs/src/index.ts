import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"
import {
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs"
import { logsClient } from "./config.js"

const worker = new Worker()
export default worker

// Three tools an agent can chain to answer questions about CloudWatch logs:
// find a log group, list its streams, then fetch events from a stream.

// ─── listLogGroups ────────────────────────────────────────────────────────────

worker.tool("listLogGroups", {
  title: "List CloudWatch Log Groups",
  description:
    "Lists CloudWatch log groups matching a name prefix. Use this to discover available log groups before fetching streams. " +
    'For example, Lambda function logs are under "/aws/lambda/", and Kinesis Data Analytics logs are under "/aws/kinesis-analytics/".',
  schema: j.object({
    prefix: j
      .string()
      .describe(
        'Log group name prefix to filter by, e.g. "/aws/lambda/" or "/aws/kinesis-analytics/".'
      ),
    limit: j
      .number()
      .nullable()
      .describe("Max number of log groups to return (default: 10, max: 50)."),
  }),
  execute: async ({ prefix, limit }) =>
    safely(async () => {
      const maxResults = clampLimit(limit, 10, 50)
      const groups: {
        logGroupName: string
        retentionDays: number | null
        storedBytes: number | null
      }[] = []
      let nextToken: string | undefined

      do {
        const response = await logsClient.send(
          new DescribeLogGroupsCommand({
            logGroupNamePrefix: prefix,
            limit: maxResults - groups.length,
            nextToken,
          })
        )
        for (const g of response.logGroups ?? []) {
          if (g.logGroupName) {
            groups.push({
              logGroupName: g.logGroupName,
              retentionDays: g.retentionInDays ?? null,
              storedBytes: g.storedBytes ?? null,
            })
          }
        }
        nextToken = groups.length < maxResults ? response.nextToken : undefined
      } while (nextToken)

      return { prefix, total: groups.length, logGroups: groups }
    }),
})

// ─── getLogStreams ────────────────────────────────────────────────────────────

worker.tool("getLogStreams", {
  title: "Get CloudWatch Log Streams",
  description:
    "Lists log streams in a CloudWatch log group, ordered by most recent event. " +
    "Use listLogGroups first to find the exact log group name. " +
    'Optionally narrow results with filterPrefix (e.g. "dag_id=my_dag_name" for Airflow, or a task/container name for other services).',
  schema: j.object({
    logGroupName: j
      .string()
      .describe(
        'Full log group name, e.g. "/aws/lambda/my-function" or "/aws/kinesis-analytics/my-flink-app-prod".'
      ),
    filterPrefix: j
      .string()
      .nullable()
      .describe(
        'Filter streams by name prefix, e.g. "dag_id=my_dag_name" to scope to a specific workflow.'
      ),
    limit: j
      .number()
      .nullable()
      .describe("Max number of streams to return (default: 10, max: 50)."),
  }),
  execute: async ({ logGroupName, filterPrefix, limit }) =>
    safely(async () => {
      const maxResults = clampLimit(limit, 10, 50)
      const streams: {
        logStreamName: string
        lastEventTime: string | null
        firstEventTime: string | null
      }[] = []
      let nextToken: string | undefined

      do {
        const response = await logsClient.send(
          new DescribeLogStreamsCommand({
            logGroupName,
            logStreamNamePrefix: filterPrefix ?? undefined,
            // Can't combine orderBy LastEventTime with a name prefix filter.
            orderBy: filterPrefix ? "LogStreamName" : "LastEventTime",
            descending: true,
            limit: Math.min(maxResults - streams.length, 50),
            nextToken,
          })
        )
        for (const s of response.logStreams ?? []) {
          if (s.logStreamName) {
            streams.push({
              logStreamName: s.logStreamName,
              lastEventTime: s.lastEventTimestamp
                ? new Date(s.lastEventTimestamp).toISOString()
                : null,
              firstEventTime: s.firstEventTimestamp
                ? new Date(s.firstEventTimestamp).toISOString()
                : null,
            })
          }
        }
        nextToken = streams.length < maxResults ? response.nextToken : undefined
      } while (nextToken)

      return {
        logGroupName,
        filterPrefix: filterPrefix ?? null,
        total: streams.length,
        logStreams: streams,
      }
    }),
})

// ─── getLogEvents ─────────────────────────────────────────────────────────────

worker.tool("getLogEvents", {
  title: "Get CloudWatch Log Events",
  description:
    "Fetches log events from a specific CloudWatch log stream. " +
    "Use getLogStreams first to find the logStreamName. " +
    'Optionally filter by time range using ISO 8601 timestamps (e.g. "2024-06-01T12:00:00Z"). ' +
    "Returns events in chronological order.",
  schema: j.object({
    logGroupName: j
      .string()
      .describe(
        'Full log group name, e.g. "/aws/lambda/my-function". Use listLogGroups to discover available groups.'
      ),
    logStreamName: j
      .string()
      .describe("Log stream name. Use getLogStreams to find this."),
    startTime: j
      .string()
      .nullable()
      .describe(
        'ISO 8601 start time (e.g. "2024-06-01T12:00:00Z"). Omit to start from the beginning of the stream.'
      ),
    endTime: j
      .string()
      .nullable()
      .describe(
        'ISO 8601 end time (e.g. "2024-06-01T13:00:00Z"). Omit to read until the end of the stream.'
      ),
    limit: j
      .number()
      .nullable()
      .describe("Max number of log events to return (default: 100, max: 500)."),
  }),
  execute: async ({ logGroupName, logStreamName, startTime, endTime, limit }) =>
    safely(async () => {
      const maxEvents = clampLimit(limit, 100, 500)
      const startMs = toEpochMs(startTime, "startTime")
      const endMs = toEpochMs(endTime, "endTime")
      const events: { timestamp: string; message: string }[] = []
      let nextForwardToken: string | undefined

      do {
        const response = await logsClient.send(
          new GetLogEventsCommand({
            logGroupName,
            logStreamName,
            startTime: startMs,
            endTime: endMs,
            limit: Math.min(maxEvents - events.length, 500),
            startFromHead: true,
            nextToken: nextForwardToken,
          })
        )

        for (const e of response.events ?? []) {
          if (e.message) {
            events.push({
              timestamp: e.timestamp ? new Date(e.timestamp).toISOString() : "",
              message: e.message.trimEnd(),
            })
          }
        }

        // GetLogEvents returns the same token when there are no more events.
        const newToken = response.nextForwardToken
        nextForwardToken =
          events.length < maxEvents && newToken !== nextForwardToken
            ? newToken
            : undefined
      } while (nextForwardToken)

      return {
        logGroupName,
        logStreamName,
        startTime: startTime ?? null,
        endTime: endTime ?? null,
        total: events.length,
        events,
      }
    }),
})

// Hand the agent a readable error instead of throwing, so it can correct itself.
async function safely<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn()
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// Clamp a nullable user-supplied limit to [1, max]; fall back to defaultVal.
export function clampLimit(
  value: number | null,
  defaultVal: number,
  max: number
): number {
  if (value == null) return defaultVal
  const n = Math.floor(value)
  if (!Number.isFinite(n) || n <= 0) return defaultVal
  return Math.min(n, max)
}

// Convert an optional ISO 8601 string to epoch ms, rejecting invalid input with
// a clear message instead of passing NaN to AWS (which returns an opaque error).
export function toEpochMs(
  value: string | null,
  label: string
): number | undefined {
  if (!value) return undefined
  const ms = new Date(value).getTime()
  if (Number.isNaN(ms)) {
    throw new Error(
      `${label} must be an ISO 8601 timestamp (e.g. "2024-06-01T12:00:00Z").`
    )
  }
  return ms
}
