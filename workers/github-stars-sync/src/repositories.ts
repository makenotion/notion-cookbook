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
    "Repository link": Schema.url(),
    Homepage: Schema.url(),
    Language: Schema.select([]),
    Topics: Schema.multiSelect([]),
    Visibility: Schema.select([
      { name: "Public" },
      { name: "Private" },
      { name: "Internal" },
    ]),
    Archived: Schema.checkbox(),
    Fork: Schema.checkbox(),
    Stars: Schema.number(),
    Forks: Schema.number(),
    "Open issues and PRs": Schema.number(),
    License: Schema.richText(),
    "Default branch": Schema.richText(),
    "Starred at": Schema.date(),
    "Last pushed": Schema.date(),
    "Repository created": Schema.date(),
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
      "Repository link": Builder.url(repository.html_url),
      Homepage: homepage ? Builder.url(homepage) : [],
      Language: language ? Builder.select(language) : [],
      Topics: topics.length > 0 ? Builder.multiSelect(...topics) : [],
      Visibility: Builder.select(label(repository.visibility)),
      Archived: Builder.checkbox(repository.archived),
      Fork: Builder.checkbox(repository.fork),
      Stars: Builder.number(repository.stargazers_count),
      Forks: Builder.number(repository.forks_count),
      "Open issues and PRs": Builder.number(repository.open_issues_count),
      License: license ? Builder.richText(license) : [],
      "Default branch": Builder.richText(repository.default_branch),
      "Starred at": Builder.dateTime(star.starred_at),
      "Last pushed": repository.pushed_at
        ? Builder.dateTime(repository.pushed_at)
        : [],
      "Repository created": Builder.dateTime(repository.created_at),
      "Repository ID": Builder.richText(String(repository.id)),
    },
  }
}
