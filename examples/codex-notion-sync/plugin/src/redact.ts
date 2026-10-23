// Secrets are removed before anything leaves the machine. The patterns cover common
// credential formats; `addSecrets` adds exact values such as the configured Notion token.
const PATTERNS: [RegExp, string][] = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, "[REDACTED_API_KEY]"],
  [/\b(?:ntn|secret)_[A-Za-z0-9]{20,}/g, "[REDACTED_NOTION_TOKEN]"],
  [
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    "[REDACTED_GITHUB_TOKEN]",
  ],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    "[REDACTED_JWT]",
  ],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [REDACTED]"],
  [
    /\b([A-Za-z0-9_]*(?:API_KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Za-z0-9_]*)(\s*[=:]\s*)(["']?)[^\s"'`,;]{6,}\3/gi,
    "$1$2$3[REDACTED]$3",
  ],
]

const exactSecrets = new Set<string>()

export function addSecrets(...values: (string | undefined)[]): void {
  for (const value of values)
    if (value && value.length >= 8) exactSecrets.add(value)
}

export function redact(text: string): string {
  let out = text
  for (const secret of exactSecrets) out = out.split(secret).join("[REDACTED]")
  for (const [pattern, replacement] of PATTERNS)
    out = out.replace(pattern, replacement)
  return out
}

// Codex stores encrypted reasoning in `encrypted_content`; it is useless to readers, so drop it.
export function redactDeep<T>(value: T): T
export function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value)
  if (Array.isArray(value)) return value.map((item) => redactDeep(item))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value))
      out[key] = key === "encrypted_content" ? "[OMITTED]" : redactDeep(item)
    return out
  }
  return value
}
