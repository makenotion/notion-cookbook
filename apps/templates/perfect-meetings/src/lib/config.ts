// Schedule settings are shared with the browser onboarding copy.
export { TIME_ZONE, MORNING_PREP_TIME } from "./schedule.js"

// Calendar scan window used by the hourly backfill (listEvents allows ≤ 1 month).
export const SCAN_DAYS_BACK = 1
export const SCAN_DAYS_AHEAD = 7

// Email research limits per attendee.
export const EMAIL_LOOKBACK_DAYS = 90
export const EMAIL_THREADS_PER_ATTENDEE = 10

// Stored event description is truncated to fit a rich text property.
export const AGENDA_MAX_CHARS = 1900

/**
 * Development switch, read from the worker's environment rather than code so
 * it applies only to the installation it is set on:
 *   ntn workers env set INCLUDE_INTERNAL_ATTENDEES=true
 * Coworkers are then treated as outside attendees. You and meeting rooms are
 * still skipped. Unset it to restore normal behaviour.
 */
export function includeInternalAttendees(): boolean {
  return /^(1|true|yes)$/i.test(process.env.INCLUDE_INTERNAL_ATTENDEES ?? "")
}
