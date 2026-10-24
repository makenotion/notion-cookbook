// Notion schema and transform for the authenticated user's starred repos.
// Provider-owned fields live in properties. The Worker intentionally does not
// write page content, leaving the page body available for personal notes.

import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

import type { GitHubStarredRepository } from "./github.js"

export const INITIAL_TITLE = "GitHub Starred Repositories"
export const PRIMARY_KEY = "Repository ID"

export const repositorySchema = {
  databaseIcon: notionIcon("star"),
  properties: {
    Repository: Schema.title(),
    Description: Schema.richText(),
    Owner: Schema.richText(),
    "Starred at": Schema.date(),
    "Last pushed": Schema.date(),
    Stars: Schema.number(),
    Archived: Schema.checkbox(),
    Topics: Schema.multiSelect([]),
    Language: Schema.select([]),
    "Repository link": Schema.url(),
    Homepage: Schema.url(),
    License: Schema.richText(),
    Visibility: Schema.select([
      { name: "Public" },
      { name: "Private" },
      { name: "Internal" },
    ]),
    Fork: Schema.checkbox(),
    Forks: Schema.number(),
    "Open issues and PRs": Schema.number(),
    "Repository created": Schema.date(),
    "Default branch": Schema.richText(),
    "Repository ID": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

function label(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function safeHomepage(value: string | null): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? trimmed
      : undefined
  } catch {
    return undefined
  }
}

function licenseLabel(star: GitHubStarredRepository): string | undefined {
  const license = star.repo.license
  if (!license) return undefined
  const spdx = license.spdx_id?.trim()
  if (spdx && spdx !== "NOASSERTION") return spdx
  return license.name.trim() || undefined
}

function uniqueTopics(topics: string[]): string[] {
  return [
    ...new Set(topics.map((topic) => topic.trim()).filter(Boolean)),
  ].sort()
}

export function repositoryToChange(
  star: GitHubStarredRepository
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof repositorySchema.properties> {
  const repository = star.repo
  const description = repository.description?.trim()
  const homepage = safeHomepage(repository.homepage)
  const language = repository.language?.trim()
  const topics = uniqueTopics(repository.topics)
  const license = licenseLabel(star)

  return {
    type: "upsert",
    key: String(repository.id),
    properties: {
      Repository: Builder.title(repository.full_name),
      Description: description ? Builder.richText(description) : [],
      Owner: Builder.richText(repository.owner.login),
      "Starred at": Builder.dateTime(star.starred_at),
      "Last pushed": repository.pushed_at
        ? Builder.dateTime(repository.pushed_at)
        : [],
      Stars: Builder.number(repository.stargazers_count),
      Archived: Builder.checkbox(repository.archived),
      Topics: topics.length > 0 ? Builder.multiSelect(...topics) : [],
      Language: language ? Builder.select(language) : [],
      "Repository link": Builder.url(repository.html_url),
      Homepage: homepage ? Builder.url(homepage) : [],
      License: license ? Builder.richText(license) : [],
      Visibility: Builder.select(label(repository.visibility)),
      Fork: Builder.checkbox(repository.fork),
      Forks: Builder.number(repository.forks_count),
      "Open issues and PRs": Builder.number(repository.open_issues_count),
      "Repository created": repository.created_at
        ? Builder.dateTime(repository.created_at)
        : [],
      "Default branch": Builder.richText(repository.default_branch),
      "Repository ID": Builder.richText(String(repository.id)),
    },
  }
}
