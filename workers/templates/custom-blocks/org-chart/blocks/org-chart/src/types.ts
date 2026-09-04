export type PersonIcon =
  | { type: "emoji"; emoji: string }
  | { type: "url"; url: string }

export type Person = {
  id: string
  name: string
  role: string
  /** Raw relation pointers to this person's manager(s). First valid one wins. */
  managerIds: string[]
  icon?: PersonIcon
}

export type OrgDataState =
  | { status: "loading" }
  | { status: "unbound" }
  | { status: "empty" }
  | { status: "ready"; people: Person[] }
