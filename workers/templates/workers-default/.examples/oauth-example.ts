import { Worker } from "@notionhq/workers"
import * as Schema from "@notionhq/workers/schema"

const worker = new Worker()
export default worker

/**
 * OAuth capabilities let your worker access third-party APIs.
 *
 * After deploying your worker, start OAuth from the CLI:
 *
 *   ntn workers oauth start <capabilityKey>
 *
 * Where `capabilityKey` is the OAuth capability's key (see `ntn workers capabilities list`).
 * Once OAuth completes, the worker runtime exposes the access token via an
 * environment variable and `accessToken()` reads it for you.
 */

// User-managed provider: you create the OAuth app and own its credentials.
// Keep client credentials in worker secrets and read them from `process.env`.
const googleAuth = worker.oauth("googleAuth", {
  name: "google-calendar",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  scope: "https://www.googleapis.com/auth/calendar.readonly",
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
  authorizationParams: {
    access_type: "offline",
    prompt: "consent",
  },
})

// Use the OAuth handles in your capabilities
const calendarEvents = worker.database("calendarEvents", {
  type: "managed",
  initialTitle: "Calendar Events",
  primaryKeyProperty: "Event ID",
  schema: {
    properties: {
      Title: Schema.title(),
      "Event ID": Schema.richText(),
    },
  },
})

worker.sync("googleCalendarSync", {
  database: calendarEvents,
  execute: async () => {
    // Get the OAuth access token
    const token = await googleAuth.accessToken()

    // Use token to fetch from Google Calendar API
    console.log("Using Google token:", `${token.slice(0, 10)}...`)

    return { changes: [], hasMore: false }
  },
})
