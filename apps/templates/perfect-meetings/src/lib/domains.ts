// Consumer mailbox domains. Attendees on these are external people without a
// company row.
const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "hey.com",
  "fastmail.com",
  "gmx.com",
  "gmx.de",
  "mail.com",
  "qq.com",
  "163.com",
  "yandex.ru",
])

// Google Calendar addresses that are not people (rooms, group calendars).
const NON_PERSON_SUFFIXES = [
  "resource.calendar.google.com",
  "group.calendar.google.com",
  "group.v.calendar.google.com",
  "import.calendar.google.com",
]

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@")
  if (at < 1 || at === email.length - 1) return null
  return normalizeEmail(email.slice(at + 1))
}

export function isPersonalDomain(domain: string): boolean {
  return PERSONAL_DOMAINS.has(domain)
}

export function isNonPersonAddress(email: string): boolean {
  const domain = emailDomain(email)
  return (
    domain === null ||
    NON_PERSON_SUFFIXES.some((suffix) => domain.endsWith(suffix))
  )
}

/** True when the domain is one of the internal domains or a subdomain of one. */
export function isInternalDomain(
  domain: string,
  internalDomains: ReadonlySet<string>
): boolean {
  for (const internal of internalDomains) {
    if (domain === internal || domain.endsWith(`.${internal}`)) return true
  }
  return false
}

/**
 * Collapse subdomains so mail.acme.example and acme.example share a company. Handles
 * common two-part public suffixes such as co.uk and com.au.
 */
export function companyDomain(domain: string): string {
  const parts = domain.split(".")
  if (parts.length <= 2) return domain
  const lastTwo = parts.slice(-2).join(".")
  const twoPartSuffix = /^(co|com|net|org|gov|ac|edu)\.[a-z]{2}$/.test(lastTwo)
  return parts.slice(twoPartSuffix ? -3 : -2).join(".")
}

/** A readable placeholder name until research fills in the real one. */
export function companyNameFromDomain(domain: string): string {
  const label = companyDomain(domain).split(".")[0] ?? domain
  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email
  return local
    .split(/[._+-]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

/** True when a name is empty or just the placeholder derived from the email. */
export function isPlaceholderName(
  name: string | null | undefined,
  email: string
): boolean {
  const value = name?.trim() ?? ""
  return value === "" || value.includes("@") || value === nameFromEmail(email)
}

/** The first candidate that is a real name rather than an email or placeholder. */
export function bestName(
  email: string,
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    if (!isPlaceholderName(candidate, email)) return candidate!.trim()
  }
  return null
}
