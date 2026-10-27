import React from "react"
import {
  ArrowUpRight,
  Building2,
  Globe2,
  Link2,
  Loader2,
  UsersRound,
} from "lucide-react"
import { pages, type NotionPage } from "@notionhq/apps/custom-blocks"

import { Avatar, AvatarFallback, AvatarImage } from "./components/ui/avatar"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import { Card, CardContent, CardFooter } from "./components/ui/card"
import { researchActivity } from "./derive"
import { profileLinks, text } from "./meeting"

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("")
}

function ProfileActivity({ row, now }: { row: NotionPage; now: number }) {
  const counts = researchActivity([row], now)
  if (counts.done || counts.unrequested) return null
  return (
    <span
      className="profile-activity"
      data-theme={counts.failed || counts.stalled ? "orange" : "gray"}
    >
      {counts.researching > 0 && (
        <Loader2 size={12} className="stage-spinner" aria-hidden="true" />
      )}
      {counts.stalled
        ? "Research may be stuck"
        : counts.failed
          ? "Research needs attention"
          : counts.queued
            ? "Research queued"
            : "Researching profile…"}
    </span>
  )
}

export function PersonCard({
  person,
  now,
}: {
  person: NotionPage
  now: number
}) {
  const email = text(person.getPropertyByKey("Email"))
  const name = text(person.getPropertyByKey("Name")) || email
  const role = text(person.getPropertyByKey("Role"))
  const source = text(person.getPropertyByKey("Role source"))
  const links = profileLinks(person)
  const sourceLink =
    /^https?:\/\//.test(source) && !links.some((link) => link.url === source)
  return (
    <li>
      <Card className="profile-card">
        <CardContent className="profile-content">
          <div className="profile-heading">
            <Avatar className="profile-avatar">
              <AvatarImage
                src={text(person.getPropertyByKey("Photo")) || undefined}
                alt=""
                referrerPolicy="no-referrer"
              />
              <AvatarFallback>{initials(name)}</AvatarFallback>
            </Avatar>
            <div className="profile-identity">
              <Button
                variant="link"
                className="profile-name"
                title={`Open ${name}'s profile`}
                onClick={() =>
                  void pages.open(person.id, { mode: "side_peek" })
                }
              >
                <span>{name}</span>
                <ArrowUpRight aria-hidden="true" />
              </Button>
              {email && text(person.getPropertyByKey("Name")) && (
                <span className="profile-email" title={email}>
                  {email}
                </span>
              )}
            </div>
          </div>
          {role && <p className="profile-role">{role}</p>}
          <div className="profile-meta">
            {text(person.getPropertyByKey("Confidence")) === "Low" && (
              <Badge
                variant="outline"
                className="confidence-badge"
                data-theme="orange"
                title="The research found a possible match. Confirm this person's identity before relying on the profile."
              >
                Possible match
              </Badge>
            )}
            <ProfileActivity row={person} now={now} />
          </div>
        </CardContent>
        {(links.length > 0 || sourceLink) && (
          <CardFooter className="profile-footer">
            {links.map((link) => (
              <Button
                key={link.label}
                variant="ghost"
                size="sm"
                className="profile-link"
                asChild
              >
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${name} on ${link.label}`}
                >
                  {link.label === "Website" ? (
                    <Globe2 aria-hidden="true" />
                  ) : (
                    <Link2 aria-hidden="true" />
                  )}
                  {link.label}
                  <ArrowUpRight
                    className="profile-link-arrow"
                    aria-hidden="true"
                  />
                </a>
              </Button>
            ))}
            {sourceLink && (
              <Button
                variant="ghost"
                size="sm"
                className="profile-link profile-source"
                asChild
              >
                <a href={source} target="_blank" rel="noopener noreferrer">
                  Role source
                  <ArrowUpRight aria-hidden="true" />
                </a>
              </Button>
            )}
          </CardFooter>
        )}
      </Card>
    </li>
  )
}

export function CompanyCard({
  domain,
  company,
  attendees,
  now,
}: {
  domain: string
  company: NotionPage | undefined
  attendees: NotionPage[]
  now: number
}) {
  const name = company
    ? text(company.getPropertyByKey("Name")) || domain
    : domain
  const summary = company ? text(company.getPropertyByKey("Summary")) : ""
  const website = company ? text(company.getPropertyByKey("Website")) : ""
  return (
    <li>
      <Card className="profile-card company-profile">
        <CardContent className="profile-content">
          <div className="profile-heading">
            <span className="company-mark" aria-hidden="true">
              <Building2 size={20} strokeWidth={1.5} />
            </span>
            <div className="profile-identity">
              {company ? (
                <Button
                  variant="link"
                  className="profile-name"
                  title={`Open ${name}'s profile`}
                  onClick={() =>
                    void pages.open(company.id, { mode: "side_peek" })
                  }
                >
                  <span>{name}</span>
                  <ArrowUpRight aria-hidden="true" />
                </Button>
              ) : (
                <span className="profile-name">{name}</span>
              )}
              <span className="profile-email">{domain}</span>
            </div>
          </div>
          {summary && <p className="profile-role company-summary">{summary}</p>}
          {company && (
            <div className="profile-meta">
              <ProfileActivity row={company} now={now} />
            </div>
          )}
        </CardContent>
        <CardFooter className="profile-footer company-footer">
          <span className="company-attendees">
            <UsersRound size={13} aria-hidden="true" />
            {attendees.length} attendee{attendees.length === 1 ? "" : "s"}
          </span>
          {/^https?:\/\//.test(website) && (
            <Button variant="ghost" size="sm" className="profile-link" asChild>
              <a href={website} target="_blank" rel="noopener noreferrer">
                <Globe2 aria-hidden="true" />
                Website
                <ArrowUpRight
                  className="profile-link-arrow"
                  aria-hidden="true"
                />
              </a>
            </Button>
          )}
        </CardFooter>
      </Card>
    </li>
  )
}
