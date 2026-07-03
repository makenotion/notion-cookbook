import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { RateLimitError } from "@notionhq/workers"

import worker from "./src/index.js"
import { directoryKey } from "./src/keys.js"
import {
  type DirectoryPerson,
  MAX_MANAGER_RELATIONS,
  peopleSchema,
  personToChange,
} from "./src/people.js"
import {
  DIRECTORY_SYNC_STATE_VERSION,
  MAX_SNAPSHOT_PAGES,
  effectiveDateInTimeZone,
  runPeopleSyncPage,
  runTeamsSyncPage,
  snapshotRequest,
  type DirectorySyncState,
  type WorkdayDirectoryClient,
  type WorkdayPageRequest,
  type WorkdayWorkersPage,
} from "./src/sync.js"
import { teamSchema, teamToChange, teamsFromPeople } from "./src/teams.js"
import {
  DEFAULT_WORKDAY_WWS_VERSION,
  WORKDAY_PAGE_SIZE,
  WORKDAY_REQUEST_TIMEOUT_MS,
  WORKDAY_SOAP_MAX_RESPONSE_BYTES,
  WORKDAY_TOKEN_MAX_RESPONSE_BYTES,
  buildGetWorkersRequest,
  createWorkdayClient,
  createWorkdayTokenProvider,
  getWorkdayConfig,
  parseGetWorkersResponse,
  parseRetryAfterSeconds,
  type WorkdayConfig,
  type WorkdayTokenProvider,
} from "./src/workday.js"

const pageRequest: WorkdayPageRequest = {
  page: 3,
  asOfEntryDateTime: "2026-07-02T14:15:16.789Z",
  asOfEffectiveDate: "2026-07-02",
}

const TEST_SOURCE_CONTRACT_FINGERPRINT = "a".repeat(64)
const stateIdentity = {
  stateVersion: DIRECTORY_SYNC_STATE_VERSION,
  sourceContractFingerprint: TEST_SOURCE_CONTRACT_FINGERPRINT,
} as const

function snapshotContext(effectiveTimeZone = "UTC") {
  return {
    effectiveTimeZone,
    sourceContractFingerprint: TEST_SOURCE_CONTRACT_FINGERPRINT,
  }
}

const baseConfig: WorkdayConfig = {
  apiUrl:
    "https://tenant1.myworkday.com/ccx/service/acme/Human_Resources/v46.1",
  apiVersion: "v46.1",
  tokenUrl: "https://tenant1.myworkday.com/ccx/oauth2/acme/token",
  clientId: "directory-client",
  clientSecret: "client-secret-never-log",
  refreshToken: "refresh-token-never-log",
  effectiveTimeZone: "America/New_York",
}

const ada: DirectoryPerson = {
  workdayWid: "wid-person-ada-private",
  name: "Ada Lovelace",
  team: {
    workdayWid: "wid-team-engineering-private",
    name: "Engineering",
  },
  managerWorkdayWids: [
    "wid-person-grace-private",
    "wid-person-alan-private",
    "wid-person-grace-private",
  ],
}

type FetchCall = {
  input: string | URL | Request
  init: RequestInit | undefined
}

function queuedFetch(
  queue: Array<Response | Error>,
  calls: FetchCall[] = []
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init })
    const next = queue.shift()
    assert.ok(next, "mock fetch queue was exhausted")
    if (next instanceof Error) throw next
    return next
  }) as typeof fetch
}

function typedReference(
  tag: string,
  wid: string,
  idTypes: string[],
  descriptor?: string
) {
  const descriptorAttribute = descriptor
    ? ` bsvc:Descriptor="${descriptor}"`
    : ""
  return [
    `<bsvc:${tag}${descriptorAttribute}>`,
    ...idTypes.map((idType) =>
      idType === "WID"
        ? `<bsvc:ID bsvc:type="WID">${wid}</bsvc:ID>`
        : `<bsvc:ID bsvc:type="${idType}">${idType.toLowerCase()}-must-ignore</bsvc:ID>`
    ),
    `</bsvc:${tag}>`,
  ].join("")
}

function widReference(tag: string, wid: string, descriptor?: string) {
  return typedReference(tag, wid, ["Employee_ID", "WID"], descriptor)
}

type WorkerFixture = {
  wid: string
  name?: string | null
  referenceDescriptor?: string
  teamWid?: string
  teamName?: string
  managerWids?: string[]
  managerReferences?: Array<{ wid: string; idTypes: string[] }>
  workerIdTypes?: string[]
  membershipCount?: number
  chainTeamWids?: string[]
  omitManagementChain?: boolean
  omitSupervisoryManagementChain?: boolean
  sensitiveData?: boolean
}

function fixtureWorker({
  wid,
  name = "Ada Lovelace",
  referenceDescriptor,
  teamWid = "team-engineering-wid",
  teamName = "Engineering",
  managerWids = ["manager-grace-wid"],
  managerReferences,
  workerIdTypes = ["Employee_ID", "WID"],
  membershipCount = 1,
  chainTeamWids = [teamWid],
  omitManagementChain = false,
  omitSupervisoryManagementChain = false,
  sensitiveData = false,
}: WorkerFixture): string {
  const memberships = Array.from({ length: membershipCount }, (_, index) => {
    const membershipWid = index === 0 ? teamWid : `${teamWid}-${index + 1}`
    return [
      "<bsvc:Worker_Organization_Data>",
      widReference("Organization_Reference", membershipWid, teamName),
      "<bsvc:Organization_Data>",
      `<bsvc:Organization_Name>${teamName}</bsvc:Organization_Name>`,
      "<bsvc:Organization_Code>sensitive-org-code</bsvc:Organization_Code>",
      "</bsvc:Organization_Data>",
      "</bsvc:Worker_Organization_Data>",
    ].join("")
  }).join("")

  const chainEntries = chainTeamWids
    .map((chainWid) =>
      [
        "<bsvc:Management_Chain_Data>",
        widReference("Organization_Reference", chainWid, teamName),
        ...(
          managerReferences ??
          managerWids.map((wid) => ({
            wid,
            idTypes: ["Employee_ID", "WID"],
          }))
        ).map((manager) =>
          typedReference(
            "Manager_Reference",
            manager.wid,
            manager.idTypes,
            "Manager Name"
          )
        ),
        "</bsvc:Management_Chain_Data>",
      ].join("")
    )
    .join("")

  return [
    "<bsvc:Worker>",
    typedReference("Worker_Reference", wid, workerIdTypes, referenceDescriptor),
    name ? `<bsvc:Worker_Descriptor>${name}</bsvc:Worker_Descriptor>` : "",
    "<bsvc:Worker_Data>",
    `<bsvc:Organization_Data>${memberships}</bsvc:Organization_Data>`,
    omitManagementChain
      ? ""
      : [
          "<bsvc:Management_Chain_Data>",
          omitSupervisoryManagementChain
            ? ""
            : [
                "<bsvc:Worker_Supervisory_Management_Chain_Data>",
                chainEntries,
                "</bsvc:Worker_Supervisory_Management_Chain_Data>",
              ].join(""),
          "</bsvc:Management_Chain_Data>",
        ].join(""),
    sensitiveData
      ? [
          "<bsvc:Personal_Data>",
          "<bsvc:Email_Address>ada.secret@example.com</bsvc:Email_Address>",
          "<bsvc:National_ID>999-00-1234</bsvc:National_ID>",
          "<bsvc:Date_of_Birth>1815-12-10</bsvc:Date_of_Birth>",
          "</bsvc:Personal_Data>",
          "<bsvc:Employment_Data>",
          "<bsvc:Business_Title>Principal Secret Keeper</bsvc:Business_Title>",
          "<bsvc:Hire_Date>2020-01-02</bsvc:Hire_Date>",
          "</bsvc:Employment_Data>",
          "<bsvc:Compensation_Data>",
          "<bsvc:Base_Pay>999999</bsvc:Base_Pay>",
          "</bsvc:Compensation_Data>",
        ].join("")
      : "",
    "</bsvc:Worker_Data>",
    "</bsvc:Worker>",
  ].join("")
}

type ResponseFixture = {
  page?: string | number
  totalPages?: string | number
  totalResults?: string | number
  pageResults?: string | number
}

function fixtureResponse(
  workers: string[],
  {
    page = 1,
    totalPages = 1,
    totalResults = workers.length,
    pageResults = workers.length,
  }: ResponseFixture = {}
): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:bsvc="urn:com.workday/bsvc">',
    "<soapenv:Body>",
    "<bsvc:Get_Workers_Response>",
    "<bsvc:Response_Results>",
    `<bsvc:Page>${page}</bsvc:Page>`,
    `<bsvc:Total_Pages>${totalPages}</bsvc:Total_Pages>`,
    `<bsvc:Total_Results>${totalResults}</bsvc:Total_Results>`,
    `<bsvc:Page_Results>${pageResults}</bsvc:Page_Results>`,
    "</bsvc:Response_Results>",
    `<bsvc:Response_Data>${workers.join("")}</bsvc:Response_Data>`,
    "</bsvc:Get_Workers_Response>",
    "</soapenv:Body>",
    "</soapenv:Envelope>",
  ].join("")
}

function clientWithPages(
  pages: WorkdayWorkersPage[],
  requests: WorkdayPageRequest[] = [],
  effectiveTimeZone = "UTC",
  sourceContractFingerprint = TEST_SOURCE_CONTRACT_FINGERPRINT
): WorkdayDirectoryClient {
  return {
    effectiveTimeZone,
    sourceContractFingerprint,
    async fetchWorkersPage(request) {
      requests.push(request)
      const page = pages.shift()
      assert.ok(page, "mock Workday page queue was exhausted")
      return page
    },
  }
}

async function captureError(action: () => unknown | Promise<unknown>) {
  try {
    await action()
  } catch (error) {
    return error
  }
  assert.fail("expected action to throw")
}

test("worker manifest declares Teams before People with exact schemas", () => {
  assert.deepEqual(
    worker.manifest.databases.map((database) => ({
      key: database.key,
      type: database.config.type,
      title: database.config.initialTitle,
      primaryKey: database.config.primaryKeyProperty,
      icon: database.config.schema.databaseIcon,
      properties: Object.keys(database.config.schema.properties),
    })),
    [
      {
        key: "teams",
        type: "managed",
        title: "Workday Teams",
        primaryKey: "Directory Key",
        icon: { type: "notion", icon: "briefcase", color: "gray" },
        properties: ["Name", "Directory Key"],
      },
      {
        key: "people",
        type: "managed",
        title: "Workday People",
        primaryKey: "Directory Key",
        icon: { type: "notion", icon: "people", color: "gray" },
        properties: ["Name", "Team", "Managers", "Directory Key"],
      },
    ]
  )

  assert.deepEqual(teamSchema.properties, {
    Name: { type: "title" },
    "Directory Key": { type: "text" },
  })
  assert.deepEqual(peopleSchema.properties, {
    Name: { type: "title" },
    Team: {
      type: "relation",
      relatedDatabaseKey: "teams",
      config: { twoWay: true, relatedPropertyName: "Members" },
    },
    Managers: {
      type: "relation",
      relatedDatabaseKey: "people",
      config: { twoWay: true, relatedPropertyName: "Direct Reports" },
    },
    "Directory Key": { type: "text" },
  })
})

test("worker manifest pins replace-mode hourly syncs behind one shared pacer", () => {
  type SyncConfig = {
    databaseKey: string
    primaryKeyProperty: string
    mode: string
    schedule: { type: string; intervalMs: number }
  }
  assert.deepEqual(worker.manifest.pacers, [
    { key: "workday", config: { allowedRequests: 4, intervalMs: 1_000 } },
  ])
  assert.deepEqual(
    worker.manifest.capabilities.map((capability) => {
      assert.equal(capability._tag, "sync")
      const config = capability.config as SyncConfig
      return { key: capability.key, ...config }
    }),
    [
      {
        key: "teamsSync",
        databaseKey: "teams",
        primaryKeyProperty: "Directory Key",
        mode: "replace",
        schedule: { type: "interval", intervalMs: 60 * 60_000 },
      },
      {
        key: "peopleSync",
        databaseKey: "people",
        primaryKeyProperty: "Directory Key",
        mode: "replace",
        schedule: { type: "interval", intervalMs: 60 * 60_000 },
      },
    ]
  )
})

test("directory keys are deterministic, trimmed, and domain separated", () => {
  const expectedDigest = createHash("sha256")
    .update("notion-workday-directory:person:worker-123", "utf8")
    .digest("hex")
    .slice(0, 32)
  assert.equal(
    directoryKey("person", " worker-123 "),
    `wd-person-${expectedDigest}`
  )
  assert.notEqual(
    directoryKey("person", "shared-wid"),
    directoryKey("team", "shared-wid")
  )
  assert.match(directoryKey("team", "shared-wid"), /^wd-team-[a-f0-9]{32}$/)
  assert.throws(() => directoryKey("person", "  "), /person WID is empty/)
  assert.throws(() => directoryKey("team", ""), /team WID is empty/)
})

test("person transform hashes identifiers, filters self, and emits co-managers", () => {
  const person = {
    ...ada,
    managerWorkdayWids: [ada.workdayWid, "manager-z", "manager-a", "manager-z"],
  }
  const change = personToChange(person)
  const personKey = directoryKey("person", ada.workdayWid)
  const teamKey = directoryKey("team", ada.team.workdayWid)
  const managerKeys = [
    directoryKey("person", "manager-a"),
    directoryKey("person", "manager-z"),
  ].sort()

  assert.deepEqual(change, {
    type: "upsert",
    key: personKey,
    properties: {
      Name: [["Ada Lovelace"]],
      Team: [{ type: "primaryKey", value: teamKey }],
      Managers: managerKeys.map((value) => ({ type: "primaryKey", value })),
      "Directory Key": [[personKey]],
    },
  })
  const serialized = JSON.stringify(change)
  for (const rawWid of [
    ada.workdayWid,
    ada.team.workdayWid,
    "manager-a",
    "manager-z",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(rawWid))
  }
})

test("person transform emits an explicit empty manager relation", () => {
  const ceo = { ...ada, managerWorkdayWids: [] }
  const person = personToChange(ceo)
  assert.deepEqual(person.properties.Managers, [])
})

test("person transform fails rather than truncating manager relations", () => {
  const atLimit = personToChange({
    ...ada,
    managerWorkdayWids: Array.from(
      { length: MAX_MANAGER_RELATIONS },
      (_, index) => `manager-${index}`
    ),
  })
  assert.equal(
    (atLimit.properties.Managers as unknown[]).length,
    MAX_MANAGER_RELATIONS
  )

  assert.throws(
    () =>
      personToChange({
        ...ada,
        managerWorkdayWids: Array.from(
          { length: MAX_MANAGER_RELATIONS + 1 },
          (_, index) => `manager-${index}`
        ),
      }),
    /more than 100 manager relations/
  )
})

test("team transform emits only its employee-visible name and opaque key", () => {
  const change = teamToChange({
    workdayWid: "team-private-wid",
    name: "Platform",
  })
  assert.deepEqual(change, {
    type: "upsert",
    key: directoryKey("team", "team-private-wid"),
    properties: {
      Name: [["Platform"]],
      "Directory Key": [[directoryKey("team", "team-private-wid")]],
    },
  })
  assert.doesNotMatch(JSON.stringify(change), /team-private-wid/)
})

test("team derivation dedupes by WID and validates only the team name", () => {
  const people: DirectoryPerson[] = [
    {
      ...ada,
      workdayWid: "person-2",
      managerWorkdayWids: ["manager-b", "manager-a", "manager-b"],
    },
    {
      ...ada,
      workdayWid: "person-1",
      managerWorkdayWids: ["manager-a", "manager-b"],
    },
    {
      ...ada,
      workdayWid: "person-3",
      team: { workdayWid: "team-accounting", name: "Accounting" },
      managerWorkdayWids: [],
    },
  ]
  assert.deepEqual(teamsFromPeople(people), [
    {
      workdayWid: "team-accounting",
      name: "Accounting",
    },
    {
      workdayWid: ada.team.workdayWid,
      name: "Engineering",
    },
  ])
  assert.throws(
    () =>
      teamsFromPeople([
        ada,
        {
          ...ada,
          workdayWid: "other-person",
          team: { ...ada.team, name: "R&D" },
        },
      ]),
    /inconsistent supervisory organization data/
  )
})

function leafElements(xml: string): Array<[string, string]> {
  return [...xml.matchAll(/<bsvc:([A-Za-z_]+)>([^<]*)<\/bsvc:\1>/g)].map(
    (match) => [match[1] ?? "", match[2] ?? ""]
  )
}

test("Get_Workers request is an exact privacy allowlist for active employees", () => {
  const xml = buildGetWorkersRequest("v46.1", pageRequest)
  assert.match(
    xml,
    /^<\?xml version="1\.0" encoding="UTF-8"\?><soapenv:Envelope /
  )
  assert.match(xml, /<bsvc:Get_Workers_Request bsvc:version="v46\.1">/)
  assert.equal(xml.endsWith("</soapenv:Envelope>"), true)

  const criteria = xml.match(
    /<bsvc:Request_Criteria>(.*?)<\/bsvc:Request_Criteria>/
  )?.[1]
  assert.ok(criteria)
  assert.deepEqual(leafElements(criteria), [
    ["Exclude_Inactive_Workers", "true"],
    ["Exclude_Employees", "false"],
    ["Exclude_Contingent_Workers", "true"],
  ])

  const filter = xml.match(
    /<bsvc:Response_Filter>(.*?)<\/bsvc:Response_Filter>/
  )?.[1]
  assert.ok(filter)
  assert.deepEqual(leafElements(filter), [
    ["As_Of_Effective_Date", pageRequest.asOfEffectiveDate],
    ["As_Of_Entry_DateTime", pageRequest.asOfEntryDateTime],
    ["Page", String(pageRequest.page)],
    ["Count", String(WORKDAY_PAGE_SIZE)],
  ])

  const responseGroup = xml.match(
    /<bsvc:Response_Group>(.*?)<\/bsvc:Response_Group>/
  )?.[1]
  assert.ok(responseGroup)
  assert.deepEqual(leafElements(responseGroup), [
    ["Include_Reference", "true"],
    ["Include_Personal_Information", "false"],
    ["Show_All_Personal_Information", "false"],
    ["Include_Additional_Jobs", "false"],
    ["Include_Employment_Information", "false"],
    ["Include_Compensation", "false"],
    ["Include_Organizations", "true"],
    ["Exclude_Organization_Support_Role_Data", "true"],
    ["Exclude_Location_Hierarchies", "true"],
    ["Exclude_Cost_Centers", "true"],
    ["Exclude_Cost_Center_Hierarchies", "true"],
    ["Exclude_Companies", "true"],
    ["Exclude_Company_Hierarchies", "true"],
    ["Exclude_Matrix_Organizations", "true"],
    ["Exclude_Pay_Groups", "true"],
    ["Exclude_Regions", "true"],
    ["Exclude_Region_Hierarchies", "true"],
    ["Exclude_Supervisory_Organizations", "false"],
    ["Exclude_Teams", "true"],
    ["Exclude_Custom_Organizations", "true"],
    ["Include_Roles", "false"],
    ["Include_Management_Chain_Data", "true"],
    ["Include_Multiple_Managers_in_Management_Chain_Data", "true"],
    ["Include_Benefit_Enrollments", "false"],
    ["Include_Benefit_Eligibility", "false"],
    ["Include_Related_Persons", "false"],
    ["Include_Qualifications", "false"],
    ["Include_Employee_Review", "false"],
    ["Include_Goals", "false"],
    ["Include_Development_Items", "false"],
    ["Include_Skills", "false"],
    ["Include_Photo", "false"],
    ["Include_Worker_Documents", "false"],
    ["Include_Transaction_Log_Data", "false"],
    ["Include_Subevents_for_Corrected_Transaction", "false"],
    ["Include_Subevents_for_Rescinded_Transaction", "false"],
    ["Include_Succession_Profile", "false"],
    ["Include_Talent_Assessment", "false"],
    ["Include_Employee_Contract_Data", "false"],
    ["Include_Contracts_for_Terminated_Workers", "false"],
    ["Include_Collective_Agreement_Data", "false"],
    ["Include_Probation_Period_Data", "false"],
    ["Include_Extended_Employee_Contract_Details", "false"],
    ["Include_Feedback_Received", "false"],
    ["Include_User_Account", "false"],
    ["Include_Career", "false"],
    ["Include_Account_Provisioning", "false"],
    ["Include_Background_Check_Data", "false"],
    ["Include_Contingent_Worker_Tax_Authority_Form_Information", "false"],
    ["Exclude_Funds", "true"],
    ["Exclude_Fund_Hierarchies", "true"],
    ["Exclude_Grants", "true"],
    ["Exclude_Grant_Hierarchies", "true"],
    ["Exclude_Business_Units", "true"],
    ["Exclude_Business_Unit_Hierarchies", "true"],
    ["Exclude_Programs", "true"],
    ["Exclude_Program_Hierarchies", "true"],
    ["Exclude_Gifts", "true"],
    ["Exclude_Gift_Hierarchies", "true"],
    ["Exclude_Retiree_Organizations", "true"],
  ])
})

test("Get_Workers request validates version, page, and pinned dates", () => {
  for (const version of ["46.1", "v46", "v46.1-beta", "v 46.1"]) {
    assert.throws(
      () => buildGetWorkersRequest(version, pageRequest),
      /SOAP version is invalid/
    )
  }
  for (const page of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => buildGetWorkersRequest("v46.1", { ...pageRequest, page }),
      /page must be a positive integer/
    )
  }
  for (const asOfEffectiveDate of [
    "2026-7-02",
    "2026-07-02T00:00:00Z",
    "not-a-date",
    "2026-02-30",
  ]) {
    assert.throws(
      () =>
        buildGetWorkersRequest("v46.1", {
          ...pageRequest,
          asOfEffectiveDate,
        }),
      /effective date must be an ISO 8601 date/
    )
  }
  for (const asOfEntryDateTime of [
    "",
    "not-a-time",
    "2026-13-01T00:00:00.000Z",
    "2026-07-02T14:15:16Z",
    "2026-07-02T10:15:16.000-04:00",
    "2026-07-02 14:15:16.000Z",
  ]) {
    assert.throws(
      () =>
        buildGetWorkersRequest("v46.1", {
          ...pageRequest,
          asOfEntryDateTime,
        }),
      /entry timestamp must be an ISO 8601 timestamp/
    )
  }
})

test("XML parser reads allowlisted names and ignores generic reference descriptors", () => {
  const xml = fixtureResponse([
    fixtureWorker({
      wid: "employee-ada-wid",
      name: "Ada Lovelace",
      referenceDescriptor: "Ada Lovelace (sensitive-employee-id)",
      teamWid: "team-platform-wid",
      teamName: "Platform",
      managerWids: ["manager-z-wid", "manager-a-wid", "manager-z-wid"],
      sensitiveData: true,
    }),
  ])
  const page = parseGetWorkersResponse(xml)
  assert.deepEqual(page, {
    page: 1,
    totalPages: 1,
    totalResults: 1,
    people: [
      {
        workdayWid: "employee-ada-wid",
        name: "Ada Lovelace",
        team: { workdayWid: "team-platform-wid", name: "Platform" },
        managerWorkdayWids: ["manager-a-wid", "manager-z-wid"],
      },
    ],
  })

  const serialized = JSON.stringify(page)
  for (const sensitiveValue of [
    "employee_id-must-ignore",
    "sensitive-employee-id",
    "sensitive-org-code",
    "ada.secret@example.com",
    "999-00-1234",
    "1815-12-10",
    "Principal Secret Keeper",
    "2020-01-02",
    "999999",
  ]) {
    assert.doesNotMatch(
      serialized,
      new RegExp(sensitiveValue.replace(/\./g, "\\."))
    )
  }
  const change = personToChange(page.people[0]!)
  assert.doesNotMatch(
    JSON.stringify(change),
    /employee-ada-wid|team-platform-wid|manager-[az]-wid/
  )
})

test("XML parser supports a CEO with no manager references", () => {
  const page = parseGetWorkersResponse(
    fixtureResponse([
      fixtureWorker({
        wid: "ceo-wid",
        name: "Chief Executive",
        teamWid: "executive-team-wid",
        teamName: "Executive Office",
        managerWids: [],
      }),
    ])
  )
  assert.deepEqual(page.people[0]?.managerWorkdayWids, [])
})

test("XML parser includes only employee manager references with a WID", () => {
  const page = parseGetWorkersResponse(
    fixtureResponse([
      fixtureWorker({
        wid: "employee-with-mixed-managers",
        managerReferences: [
          {
            wid: "employee-manager-wid",
            idTypes: ["Employee_ID", "WID"],
          },
          { wid: "wid-only-manager", idTypes: ["WID"] },
          {
            wid: "contingent-manager-wid",
            idTypes: ["Contingent_Worker_ID", "WID"],
          },
          { wid: "employee-id-only", idTypes: ["Employee_ID"] },
        ],
      }),
    ])
  )
  assert.deepEqual(page.people[0]?.managerWorkdayWids, ["employee-manager-wid"])
})

test("XML parser rejects non-employee top-level worker references", () => {
  for (const workerIdTypes of [
    ["WID"],
    ["Contingent_Worker_ID", "WID"],
    ["Employee_ID", "Contingent_Worker_ID", "WID"],
  ]) {
    assert.throws(
      () =>
        parseGetWorkersResponse(
          fixtureResponse([
            fixtureWorker({
              wid: "non-employee-worker",
              workerIdTypes,
            }),
          ])
        ),
      /non-employee worker reference/
    )
  }
  assert.throws(
    () =>
      parseGetWorkersResponse(
        fixtureResponse([
          fixtureWorker({
            wid: "employee-without-wid",
            workerIdTypes: ["Employee_ID"],
          }),
        ])
      ),
    /missing Worker_Reference WID/
  )
  assert.throws(
    () =>
      parseGetWorkersResponse(
        fixtureResponse([
          fixtureWorker({
            wid: "employee-with-duplicate-wids",
            workerIdTypes: ["Employee_ID", "WID", "WID"],
          }),
        ])
      ),
    /missing Worker_Reference WID/
  )
})

test("XML parser rejects duplicate workers and ambiguous team membership", () => {
  const duplicate = fixtureWorker({ wid: "duplicate-worker-wid" })
  assert.throws(
    () => parseGetWorkersResponse(fixtureResponse([duplicate, duplicate])),
    /duplicate employee/
  )
  assert.throws(
    () =>
      parseGetWorkersResponse(
        fixtureResponse([
          fixtureWorker({ wid: "no-team-worker", membershipCount: 0 }),
        ])
      ),
    /missing Organization_Data|exactly one in-scope supervisory organization/
  )
  assert.throws(
    () =>
      parseGetWorkersResponse(
        fixtureResponse([
          fixtureWorker({ wid: "two-team-worker", membershipCount: 2 }),
        ])
      ),
    /exactly one in-scope supervisory organization/
  )
})

test("XML parser requires one matching supervisory management-chain entry", () => {
  assert.throws(
    () =>
      parseGetWorkersResponse(
        fixtureResponse([
          fixtureWorker({
            wid: "mismatch-worker",
            teamWid: "current-team",
            chainTeamWids: ["other-team"],
          }),
        ])
      ),
    /management chain does not match/
  )
  assert.throws(
    () =>
      parseGetWorkersResponse(
        fixtureResponse([
          fixtureWorker({
            wid: "duplicate-chain-worker",
            teamWid: "current-team",
            chainTeamWids: ["current-team", "current-team"],
          }),
        ])
      ),
    /management chain does not match/
  )
  assert.throws(
    () =>
      parseGetWorkersResponse(
        fixtureResponse([
          fixtureWorker({
            wid: "missing-chain-worker",
            omitManagementChain: true,
          }),
        ])
      ),
    /missing requested supervisory management-chain data/
  )
  assert.throws(
    () =>
      parseGetWorkersResponse(
        fixtureResponse([
          fixtureWorker({
            wid: "missing-supervisory-chain-worker",
            omitSupervisoryManagementChain: true,
          }),
        ])
      ),
    /missing requested supervisory management-chain data/
  )
  assert.throws(
    () =>
      parseGetWorkersResponse(
        fixtureResponse([
          fixtureWorker({
            wid: "empty-chain-worker",
            chainTeamWids: [],
          }),
        ])
      ),
    /missing requested supervisory management-chain data/
  )
})

test("XML parser fails closed on SOAP faults, malformed, and incomplete payloads", () => {
  const fault = [
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">',
    "<soapenv:Body><soapenv:Fault>",
    "<faultcode>soapenv:Server</faultcode>",
    "<faultstring>private upstream detail</faultstring>",
    "</soapenv:Fault></soapenv:Body></soapenv:Envelope>",
  ].join("")
  assert.throws(() => parseGetWorkersResponse(fault), /SOAP fault/)
  assert.throws(
    () => parseGetWorkersResponse("<soapenv:Envelope><"),
    /malformed XML|missing Envelope|missing SOAP Body/
  )
  assert.throws(
    () => parseGetWorkersResponse("not xml"),
    /malformed XML|missing Envelope/
  )
  assert.throws(
    () =>
      parseGetWorkersResponse(
        '<soapenv:Envelope xmlns:soapenv="x"><soapenv:Body/></soapenv:Envelope>'
      ),
    /missing SOAP Body|missing Get_Workers_Response/
  )
  assert.throws(
    () => parseGetWorkersResponse(fixtureResponse([])),
    /missing Response_Data|incomplete directory response/
  )
  assert.throws(
    () =>
      parseGetWorkersResponse(
        fixtureResponse([
          fixtureWorker({
            wid: "missing-person-name",
            name: null,
            referenceDescriptor: "Name (private-id)",
          }),
        ])
      ),
    /missing Worker_Descriptor/
  )
  assert.throws(
    () =>
      parseGetWorkersResponse(
        fixtureResponse([
          fixtureWorker({
            wid: "missing-team-name",
            teamName: "",
          }),
        ])
      ),
    /missing supervisory organization name/
  )
})

test("XML parser validates page totals and page-result counts", () => {
  const employee = fixtureWorker({ wid: "employee-one" })
  for (const fixture of [
    { page: 0 },
    { page: 2, totalPages: 1 },
    { totalPages: 0 },
    { totalResults: 0 },
    { pageResults: 0 },
    { pageResults: 2 },
  ]) {
    assert.throws(
      () => parseGetWorkersResponse(fixtureResponse([employee], fixture)),
      /incomplete directory response/
    )
  }
  for (const fixture of [
    { page: "one" },
    { totalPages: "1.5" },
    { totalResults: "-1" },
    { pageResults: "NaN" },
    { totalResults: "9007199254740993" },
  ]) {
    assert.throws(
      () => parseGetWorkersResponse(fixtureResponse([employee], fixture)),
      /invalid (Page|Total_Pages|Total_Results|Page_Results)/
    )
  }
  assert.throws(
    () =>
      parseGetWorkersResponse(
        fixtureResponse([employee], { totalResults: 1, totalPages: 2 })
      ),
    /incomplete directory response/
  )
})

test("XML parser enforces Workday's page-size-derived totals", () => {
  const hundredWorkers = Array.from({ length: WORKDAY_PAGE_SIZE }, (_, index) =>
    fixtureWorker({ wid: `page-one-worker-${index}` })
  )
  assert.equal(
    parseGetWorkersResponse(
      fixtureResponse(hundredWorkers, {
        page: 1,
        totalPages: 2,
        totalResults: 101,
        pageResults: 100,
      })
    ).people.length,
    100
  )
  assert.throws(
    () =>
      parseGetWorkersResponse(
        fixtureResponse(hundredWorkers.slice(0, 99), {
          page: 1,
          totalPages: 2,
          totalResults: 101,
          pageResults: 99,
        })
      ),
    /incomplete directory response/
  )
  assert.throws(
    () =>
      parseGetWorkersResponse(
        fixtureResponse(
          [
            fixtureWorker({ wid: "final-worker-one" }),
            fixtureWorker({ wid: "final-worker-two" }),
          ],
          { page: 2, totalPages: 2, totalResults: 101, pageResults: 2 }
        )
      ),
    /incomplete directory response/
  )
  assert.throws(
    () =>
      parseGetWorkersResponse(
        fixtureResponse([fixtureWorker({ wid: "worker-one" })], {
          page: 1,
          totalPages: 2,
          totalResults: 1,
          pageResults: 1,
        })
      ),
    /incomplete directory response/
  )
})

test("effective date uses the configured business time zone", () => {
  const instant = new Date("2026-01-01T00:30:00.000Z")
  assert.equal(effectiveDateInTimeZone(instant, "UTC"), "2026-01-01")
  assert.equal(
    effectiveDateInTimeZone(instant, "America/Los_Angeles"),
    "2025-12-31"
  )
  assert.equal(effectiveDateInTimeZone(instant, "Asia/Tokyo"), "2026-01-01")
  assert.throws(
    () => effectiveDateInTimeZone(instant, "Mars/Olympus_Mons"),
    /valid IANA zone/
  )
  assert.throws(
    () => effectiveDateInTimeZone(new Date(Number.NaN), "UTC"),
    /snapshot time is invalid/
  )
})

test("snapshot request captures one timestamp and tenant-local date", () => {
  let clockCalls = 0
  const request = snapshotRequest(
    undefined,
    snapshotContext("America/Los_Angeles"),
    () => {
      clockCalls++
      return new Date("2026-01-01T00:30:00.123Z")
    }
  )
  assert.equal(clockCalls, 1)
  assert.deepEqual(request, {
    page: 1,
    asOfEntryDateTime: "2026-01-01T00:30:00.123Z",
    asOfEffectiveDate: "2025-12-31",
  })
  assert.throws(
    () =>
      snapshotRequest(undefined, snapshotContext(), () => new Date(Number.NaN)),
    /snapshot time is invalid/
  )
})

test("resumed snapshot preserves canonical pinned state", () => {
  let clockCalled = false
  const request = snapshotRequest(
    {
      ...stateIdentity,
      page: 2,
      asOfEntryDateTime: "2026-07-02T14:15:16.000Z",
      asOfEffectiveDate: "2026-07-02",
      totalPages: 3,
      totalResults: 201,
    },
    snapshotContext(),
    () => {
      clockCalled = true
      return new Date()
    }
  )
  assert.equal(clockCalled, false)
  assert.deepEqual(request, {
    page: 2,
    asOfEntryDateTime: "2026-07-02T14:15:16.000Z",
    asOfEffectiveDate: "2026-07-02",
  })
})

test("snapshot state validation rejects unsafe page and total boundaries", () => {
  const valid: DirectorySyncState = {
    ...stateIdentity,
    page: 2,
    asOfEntryDateTime: "2026-07-02T14:15:16.000Z",
    asOfEffectiveDate: "2026-07-02",
    totalPages: 3,
    totalResults: 201,
  }
  const invalidStates: Array<[Partial<DirectorySyncState>, RegExp]> = [
    [{ page: 1 }, /invalid page boundary/],
    [{ page: 4 }, /invalid page boundary/],
    [{ page: 2.5 }, /page must be a positive integer/],
    [
      { page: MAX_SNAPSHOT_PAGES + 1, totalPages: MAX_SNAPSHOT_PAGES + 1 },
      /invalid page boundary/,
    ],
    [{ totalPages: 0 }, /totalPages must be a positive integer/],
    [{ totalResults: 0 }, /totalResults must be a positive integer/],
    [{ totalResults: -1 }, /totalResults must be a positive integer/],
    [{ totalResults: 1.25 }, /totalResults must be a positive integer/],
    [{ totalPages: MAX_SNAPSHOT_PAGES + 1 }, /invalid page boundary/],
    [{ totalResults: 301 }, /invalid page boundary/],
    [{ asOfEntryDateTime: "" }, /ISO 8601 timestamp/],
    [{ asOfEntryDateTime: "not-a-time" }, /ISO 8601 timestamp/],
    [
      { asOfEntryDateTime: "2026-07-02T10:15:16.000-04:00" },
      /ISO 8601 timestamp/,
    ],
    [{ asOfEntryDateTime: "2026-07-02T14:15:16Z" }, /ISO 8601 timestamp/],
    [{ asOfEffectiveDate: "2026-7-2" }, /ISO 8601 date/],
    [{ asOfEffectiveDate: "2026-02-30" }, /ISO 8601 date/],
  ]
  for (const [override, expected] of invalidStates) {
    assert.throws(
      () => snapshotRequest({ ...valid, ...override }, snapshotContext()),
      expected
    )
  }
})

test("sync rejects incompatible persisted state before fetching", async () => {
  const requests: WorkdayPageRequest[] = []
  const client = clientWithPages(
    [{ page: 2, totalPages: 3, totalResults: 201, people: [ada] }],
    requests
  )
  const valid = {
    ...stateIdentity,
    page: 2,
    asOfEntryDateTime: "2026-07-02T14:15:16.000Z",
    asOfEffectiveDate: "2026-07-02",
    totalPages: 3,
    totalResults: 201,
  }
  const { stateVersion: _stateVersion, ...legacyState } = valid
  const incompatibleStates = [
    legacyState,
    { ...valid, stateVersion: DIRECTORY_SYNC_STATE_VERSION + 1 },
    { ...valid, sourceContractFingerprint: "b".repeat(64) },
  ]

  for (const state of incompatibleStates) {
    await assert.rejects(
      () => runPeopleSyncPage(client, state as unknown as DirectorySyncState),
      /sync state is incompatible/
    )
  }
  assert.equal(requests.length, 0)
})

test("snapshot ceiling is 100 pages and 10,000 employees", () => {
  assert.equal(MAX_SNAPSHOT_PAGES, 100)
  assert.equal(MAX_SNAPSHOT_PAGES * WORKDAY_PAGE_SIZE, 10_000)
  assert.deepEqual(
    snapshotRequest(
      {
        ...stateIdentity,
        page: MAX_SNAPSHOT_PAGES,
        asOfEntryDateTime: "2026-07-02T14:15:16.000Z",
        asOfEffectiveDate: "2026-07-02",
        totalPages: MAX_SNAPSHOT_PAGES,
        totalResults: MAX_SNAPSHOT_PAGES * WORKDAY_PAGE_SIZE,
      },
      snapshotContext()
    ),
    {
      page: 100,
      asOfEntryDateTime: "2026-07-02T14:15:16.000Z",
      asOfEffectiveDate: "2026-07-02",
    }
  )
  assert.throws(
    () =>
      snapshotRequest(
        {
          ...stateIdentity,
          page: MAX_SNAPSHOT_PAGES + 1,
          asOfEntryDateTime: "2026-07-02T14:15:16.000Z",
          asOfEffectiveDate: "2026-07-02",
          totalPages: MAX_SNAPSHOT_PAGES + 1,
          totalResults: (MAX_SNAPSHOT_PAGES + 1) * WORKDAY_PAGE_SIZE,
        },
        snapshotContext()
      ),
    /invalid page boundary/
  )
})

test("people sync reuses snapshot state across pages and finalizes cleanly", async () => {
  const requests: WorkdayPageRequest[] = []
  const secondPerson: DirectoryPerson = {
    ...ada,
    workdayWid: "wid-person-second",
    name: "Grace Hopper",
  }
  const client = clientWithPages(
    [
      { page: 1, totalPages: 2, totalResults: 101, people: [ada] },
      { page: 2, totalPages: 2, totalResults: 101, people: [secondPerson] },
    ],
    requests,
    "America/Los_Angeles"
  )
  const first = await runPeopleSyncPage(
    client,
    undefined,
    () => new Date("2026-01-01T00:30:00.000Z")
  )
  assert.equal(first.hasMore, true)
  assert.deepEqual(first.changes, [personToChange(ada)])
  assert.deepEqual(first.nextState, {
    ...stateIdentity,
    page: 2,
    asOfEntryDateTime: "2026-01-01T00:30:00.000Z",
    asOfEffectiveDate: "2025-12-31",
    totalPages: 2,
    totalResults: 101,
  })

  const second = await runPeopleSyncPage(client, first.nextState)
  assert.equal(second.hasMore, false)
  assert.deepEqual(second.changes, [personToChange(secondPerson)])
  assert.equal("nextState" in second, false)
  assert.deepEqual(requests, [
    {
      page: 1,
      asOfEntryDateTime: "2026-01-01T00:30:00.000Z",
      asOfEffectiveDate: "2025-12-31",
    },
    {
      page: 2,
      asOfEntryDateTime: "2026-01-01T00:30:00.000Z",
      asOfEffectiveDate: "2025-12-31",
    },
  ])
})

test("teams sync publishes one deterministic team change per page", async () => {
  const teammate = { ...ada, workdayWid: "other-person" }
  const client = clientWithPages([
    { page: 1, totalPages: 1, totalResults: 2, people: [teammate, ada] },
  ])
  const result = await runTeamsSyncPage(
    client,
    undefined,
    () => new Date("2026-07-02T14:15:16Z")
  )
  assert.deepEqual(result, {
    changes: [
      teamToChange({
        workdayWid: ada.team.workdayWid,
        name: ada.team.name,
      }),
    ],
    hasMore: false,
  })
})

test("sync rejects wrong pages, drifting totals, empty pages, and page overflow", async () => {
  const state: DirectorySyncState = {
    ...stateIdentity,
    page: 2,
    asOfEntryDateTime: "2026-07-02T14:15:16.000Z",
    asOfEffectiveDate: "2026-07-02",
    totalPages: 3,
    totalResults: 201,
  }
  const failures: Array<[WorkdayWorkersPage, RegExp]> = [
    [
      { page: 1, totalPages: 3, totalResults: 201, people: [ada] },
      /different page than requested/,
    ],
    [
      { page: 2, totalPages: 4, totalResults: 201, people: [ada] },
      /snapshot totals changed/,
    ],
    [
      { page: 2, totalPages: 3, totalResults: 202, people: [ada] },
      /snapshot totals changed/,
    ],
    [
      { page: 2, totalPages: 3, totalResults: 201, people: [] },
      /incomplete directory snapshot/,
    ],
    [
      {
        page: 2,
        totalPages: MAX_SNAPSHOT_PAGES + 1,
        totalResults: 201,
        people: [ada],
      },
      /incomplete directory snapshot/,
    ],
    [
      { page: 2, totalPages: 1, totalResults: 201, people: [ada] },
      /incomplete directory snapshot/,
    ],
    [
      { page: 2, totalPages: 0, totalResults: 201, people: [ada] },
      /totalPages must be a positive integer/,
    ],
    [
      { page: 2, totalPages: 3, totalResults: 0, people: [ada] },
      /totalResults must be a positive integer/,
    ],
  ]
  for (const [page, expected] of failures) {
    await assert.rejects(
      () => runPeopleSyncPage(clientWithPages([page]), state),
      expected
    )
  }
})

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    WORKDAY_API_URL:
      "https://tenant1.myworkday.com/ccx/service/acme/Human_Resources/v46.1",
    WORKDAY_API_VERSION: "v46.1",
    WORKDAY_TOKEN_URL: "https://tenant1.myworkday.com/ccx/oauth2/acme/token",
    WORKDAY_CLIENT_ID: " directory-client ",
    WORKDAY_CLIENT_SECRET: " client-secret ",
    WORKDAY_REFRESH_TOKEN: " refresh-token ",
    WORKDAY_EFFECTIVE_TIME_ZONE: " America/New_York ",
    ...overrides,
  }
}

test("configuration accepts the pinned tenant WWS endpoint", () => {
  assert.deepEqual(getWorkdayConfig(validEnv()), {
    apiUrl:
      "https://tenant1.myworkday.com/ccx/service/acme/Human_Resources/v46.1",
    apiVersion: "v46.1",
    tokenUrl: "https://tenant1.myworkday.com/ccx/oauth2/acme/token",
    clientId: "directory-client",
    clientSecret: "client-secret",
    refreshToken: "refresh-token",
    effectiveTimeZone: "America/New_York",
  })
  const defaults = getWorkdayConfig(
    validEnv({
      WORKDAY_API_URL:
        "https://tenant1.myworkday.com/ccx/service/acme/Human_Resources/v46.1/",
      WORKDAY_EFFECTIVE_TIME_ZONE: "UTC",
      WORKDAY_API_VERSION: undefined,
    })
  )
  assert.equal(defaults.apiVersion, DEFAULT_WORKDAY_WWS_VERSION)
  assert.equal(defaults.effectiveTimeZone, "UTC")
  assert.equal(
    defaults.apiUrl,
    "https://tenant1.myworkday.com/ccx/service/acme/Human_Resources/v46.1/"
  )
  assert.equal(
    getWorkdayConfig(
      validEnv({
        WORKDAY_EXTERNAL_APPLICATION_ID: " notion-workday-org-chart ",
      })
    ).externalApplicationId,
    "notion-workday-org-chart"
  )
  assert.equal(
    getWorkdayConfig({
      ...validEnv(),
      WORKDAY_TOKEN_URL: "https://tenant1.myworkday.com/oauth2/acme/token",
    }).tokenUrl,
    "https://tenant1.myworkday.com/oauth2/acme/token"
  )
})

test("configuration rejects unpinned, non-HTTPS, credentialed, and decorated URLs", () => {
  const invalidApiUrls = [
    "http://workday.example/Human_Resources/v46.1",
    "not a URL",
    "https://user:password@workday.example/Human_Resources/v46.1",
    "https://workday.example/Human_Resources/v46.1?tenant=acme",
    "https://workday.example/Human_Resources/v46.1#fragment",
    "https://workday.example/Human_Resources/v45.0",
    "https://workday.example/Financial_Management/v46.1",
    "https://evil.example/Human_Resources/v46.1",
    "https://tenant1.myworkday.com:8443/Human_Resources/v46.1",
    "https://api.workday.com/v1/tenants/acme/soap/v46.1/Human_Resources",
    "https://tenant1.myworkday.com/ccx/service/Human_Resources/v46.1",
    "https://tenant1.myworkday.com/ccx/service/acme/extra/Human_Resources/v46.1",
  ]
  for (const WORKDAY_API_URL of invalidApiUrls) {
    assert.throws(
      () => getWorkdayConfig(validEnv({ WORKDAY_API_URL })),
      /WORKDAY_API_URL must be/
    )
  }

  const invalidTokenUrls = [
    "http://workday.example/oauth2/token",
    "not a URL",
    "https://user:password@workday.example/oauth2/token",
    "https://workday.example/oauth2/token?scope=all",
    "https://workday.example/oauth2/token#fragment",
    "https://workday.example/oauth2/authorize",
    "https://evil.example/oauth2/token",
    "https://tenant1.myworkday.com:8443/oauth2/token",
    "https://tenant2.myworkday.com/ccx/oauth2/acme/token",
    "https://tenant1.myworkday.com/ccx/oauth2/other-tenant/token",
    "https://tenant1.myworkday.com/ccx/oauth2/token",
  ]
  for (const WORKDAY_TOKEN_URL of invalidTokenUrls) {
    assert.throws(
      () => getWorkdayConfig(validEnv({ WORKDAY_TOKEN_URL })),
      /WORKDAY_TOKEN_URL must be/
    )
  }
})

test("configuration validates version, timezone, and every required secret", () => {
  for (const WORKDAY_API_VERSION of ["46.1", "v46", "latest", "v46.1-beta"]) {
    assert.throws(
      () => getWorkdayConfig(validEnv({ WORKDAY_API_VERSION })),
      /WORKDAY_API_VERSION must look like/
    )
  }
  assert.throws(
    () =>
      getWorkdayConfig(
        validEnv({ WORKDAY_EFFECTIVE_TIME_ZONE: "Mars/Olympus_Mons" })
      ),
    /valid IANA zone/
  )
  for (const name of [
    "WORKDAY_API_URL",
    "WORKDAY_TOKEN_URL",
    "WORKDAY_CLIENT_ID",
    "WORKDAY_CLIENT_SECRET",
    "WORKDAY_REFRESH_TOKEN",
    "WORKDAY_EFFECTIVE_TIME_ZONE",
  ] as const) {
    assert.throws(
      () => getWorkdayConfig(validEnv({ [name]: "  " })),
      new RegExp(`${name} is not set`)
    )
  }
  for (const WORKDAY_EXTERNAL_APPLICATION_ID of [
    "a".repeat(51),
    "notion-workday\norg-chart",
    "notion-workday-☃",
  ]) {
    assert.throws(
      () => getWorkdayConfig(validEnv({ WORKDAY_EXTERNAL_APPLICATION_ID })),
      /valid HTTP header value of at most 50 characters/
    )
  }
})

test("Retry-After parser handles seconds, HTTP dates, and invalid input", () => {
  const now = Date.parse("2026-07-02T14:15:16.000Z")
  assert.equal(parseRetryAfterSeconds("7", now), 7)
  assert.equal(parseRetryAfterSeconds("3.01", now), 4)
  assert.equal(parseRetryAfterSeconds("0", now), 0)
  assert.equal(parseRetryAfterSeconds("Thu, 02 Jul 2026 14:15:23 GMT", now), 7)
  assert.equal(parseRetryAfterSeconds("Thu, 02 Jul 2026 14:15:00 GMT", now), 0)
  assert.equal(parseRetryAfterSeconds("-1", now), undefined)
  assert.equal(parseRetryAfterSeconds("not-a-date", now), undefined)
  assert.equal(parseRetryAfterSeconds("", now), undefined)
  assert.equal(parseRetryAfterSeconds(null, now), undefined)
})

test("OAuth token provider coalesces concurrency, caches, and invalidates safely", async () => {
  const calls: FetchCall[] = []
  let pacingCalls = 0
  const provider = createWorkdayTokenProvider(
    baseConfig,
    async () => {
      pacingCalls++
    },
    queuedFetch(
      [
        Response.json({
          access_token: "first-access-token",
          token_type: "Bearer",
        }),
        Response.json({
          access_token: "second-access-token",
          token_type: "bearer",
        }),
      ],
      calls
    )
  )

  assert.deepEqual(
    await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]),
    ["first-access-token", "first-access-token", "first-access-token"]
  )
  assert.equal(calls.length, 1)
  assert.equal(pacingCalls, 1)
  assert.equal(await provider.getAccessToken(), "first-access-token")
  assert.equal(calls.length, 1)

  provider.invalidate("some-other-token")
  assert.equal(await provider.getAccessToken(), "first-access-token")
  assert.equal(calls.length, 1)
  provider.invalidate("first-access-token")
  assert.equal(await provider.getAccessToken(), "second-access-token")
  assert.equal(calls.length, 2)
  assert.equal(pacingCalls, 2)
})

test("OAuth request uses Basic auth and refresh-token form encoding", async () => {
  const calls: FetchCall[] = []
  let paced = false
  const config = {
    ...baseConfig,
    clientId: "client:id",
    clientSecret: "secret/value",
    refreshToken: "refresh token + value",
  }
  const provider = createWorkdayTokenProvider(
    config,
    async () => {
      paced = true
    },
    queuedFetch(
      [Response.json({ access_token: "opaque-token", token_type: "BEARER" })],
      calls
    )
  )
  assert.equal(await provider.getAccessToken(), "opaque-token")
  assert.equal(paced, true)
  assert.equal(WORKDAY_REQUEST_TIMEOUT_MS, 60_000)
  assert.equal(String(calls[0]?.input), config.tokenUrl)
  assert.ok(calls[0]?.init?.signal instanceof AbortSignal)
  assert.equal(calls[0]?.init?.signal?.aborted, false)
  assert.deepEqual(
    {
      method: calls[0]?.init?.method,
      redirect: calls[0]?.init?.redirect,
      accept: new Headers(calls[0]?.init?.headers).get("accept"),
      contentType: new Headers(calls[0]?.init?.headers).get("content-type"),
      authorization: new Headers(calls[0]?.init?.headers).get("authorization"),
      body: String(calls[0]?.init?.body),
    },
    {
      method: "POST",
      redirect: "error",
      accept: "application/json",
      contentType: "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from("client:id:secret/value").toString("base64")}`,
      body: "grant_type=refresh_token&refresh_token=refresh+token+%2B+value",
    }
  )
})

test("OAuth failures expose status but never response bodies or credentials", async () => {
  const upstreamSecrets = [
    baseConfig.clientSecret,
    baseConfig.refreshToken,
    "private-oauth-response-body",
  ]
  const cases: Array<[Response | Error, RegExp]> = [
    [
      new Error(`network included ${baseConfig.clientSecret}`),
      /failed before receiving/,
    ],
    [
      new Response("private-oauth-response-body", { status: 400 }),
      /failed \(400\)/,
    ],
    [new Response("{not json", { status: 200 }), /missing access_token/],
    [Response.json({ token_type: "Bearer" }), /missing access_token/],
    [Response.json({ access_token: "   " }), /missing access_token/],
    [
      Response.json({ access_token: "token", token_type: "MAC" }),
      /unsupported token type/,
    ],
    [
      Response.json({ access_token: "token", token_type: 123 }),
      /unsupported token type/,
    ],
  ]
  for (const [response, expected] of cases) {
    const provider = createWorkdayTokenProvider(
      baseConfig,
      async () => {},
      queuedFetch([response])
    )
    const error = await captureError(() => provider.getAccessToken())
    assert.ok(error instanceof Error)
    assert.match(error.message, expected)
    for (const secret of upstreamSecrets) {
      assert.doesNotMatch(error.message, new RegExp(secret))
    }
    assert.equal(error instanceof RateLimitError, false)
  }
})

test("OAuth rejects oversized declared and streamed bodies without leakage", async () => {
  const declaredSecret = "private oversized OAuth response"
  const declaredProvider = createWorkdayTokenProvider(
    baseConfig,
    async () => {},
    queuedFetch([
      new Response(declaredSecret, {
        status: 200,
        headers: {
          "Content-Length": String(WORKDAY_TOKEN_MAX_RESPONSE_BYTES + 1),
        },
      }),
    ])
  )
  const declaredError = await captureError(() =>
    declaredProvider.getAccessToken()
  )
  assert.ok(declaredError instanceof Error)
  assert.equal(declaredError instanceof RateLimitError, false)
  assert.match(
    declaredError.message,
    /OAuth response exceeded the allowed size/
  )
  assert.doesNotMatch(declaredError.message, /private|oversized/)

  const streamedProvider = createWorkdayTokenProvider(
    baseConfig,
    async () => {},
    queuedFetch([
      new Response(new Uint8Array(WORKDAY_TOKEN_MAX_RESPONSE_BYTES + 1), {
        status: 200,
      }),
    ])
  )
  const streamedError = await captureError(() =>
    streamedProvider.getAccessToken()
  )
  assert.ok(streamedError instanceof Error)
  assert.equal(streamedError instanceof RateLimitError, false)
  assert.match(
    streamedError.message,
    /OAuth response exceeded the allowed size/
  )
})

test("OAuth 429 and gateway overload responses become rate-limit errors", async () => {
  const responses = [429, 502, 503, 504].map(
    (status) =>
      new Response(`private ${status} service detail`, {
        status,
        ...(status === 429 ? { headers: { "Retry-After": "6.2" } } : {}),
      })
  )
  for (const [index, response] of responses.entries()) {
    const provider = createWorkdayTokenProvider(
      baseConfig,
      async () => {},
      queuedFetch([response])
    )
    const error = await captureError(() => provider.getAccessToken())
    assert.ok(error instanceof RateLimitError)
    assert.equal(error.retryAfter, index === 0 ? 7 : undefined)
    assert.doesNotMatch(error.message, /private|client-secret|refresh-token/)
  }

  const ordinary = createWorkdayTokenProvider(
    baseConfig,
    async () => {},
    queuedFetch([new Response("server failure", { status: 500 })])
  )
  const ordinaryError = await captureError(() => ordinary.getAccessToken())
  assert.ok(ordinaryError instanceof Error)
  assert.equal(ordinaryError instanceof RateLimitError, false)
  assert.match(ordinaryError.message, /failed \(500\)/)
})

function staticTokenProvider(
  tokens: string[],
  invalidated: string[] = []
): WorkdayTokenProvider {
  let index = 0
  return {
    async getAccessToken() {
      const token = tokens[index]
      assert.ok(token, "mock token queue was exhausted")
      return token
    },
    invalidate(accessToken) {
      invalidated.push(accessToken)
      index++
    },
  }
}

test("source contract fingerprint is stable but source-bound", () => {
  const fingerprint = (config: WorkdayConfig) =>
    createWorkdayClient(
      config,
      staticTokenProvider(["unused-token"]),
      async () => {},
      queuedFetch([])
    ).sourceContractFingerprint

  const baseline = fingerprint(baseConfig)
  assert.match(baseline, /^[a-f0-9]{64}$/)
  assert.equal(
    fingerprint({
      ...baseConfig,
      apiUrl: `${baseConfig.apiUrl}/`,
      tokenUrl: "https://tenant1.myworkday.com/ccx/oauth2/acme/new-token",
      clientSecret: "rotated-secret",
      refreshToken: "rotated-refresh-token",
      externalApplicationId: "new-observability-label",
    }),
    baseline
  )
  for (const changedSource of [
    {
      ...baseConfig,
      apiUrl:
        "https://tenant2.myworkday.com/ccx/service/acme/Human_Resources/v46.1",
    },
    {
      ...baseConfig,
      apiUrl:
        "https://tenant1.myworkday.com/ccx/service/acme/Human_Resources/v47.0",
      apiVersion: "v47.0",
    },
    { ...baseConfig, clientId: "different-api-client" },
    { ...baseConfig, effectiveTimeZone: "UTC" },
  ]) {
    assert.notEqual(fingerprint(changedSource), baseline)
  }
})

test("SOAP page 1 omits the strict client timeout", async () => {
  const calls: FetchCall[] = []
  const client = createWorkdayClient(
    baseConfig,
    staticTokenProvider(["soap-access-token"]),
    async () => {},
    queuedFetch(
      [
        new Response(
          fixtureResponse([
            fixtureWorker({ wid: "page-one-worker", managerWids: [] }),
          ]),
          { status: 200 }
        ),
      ],
      calls
    )
  )

  await client.fetchWorkersPage({ ...pageRequest, page: 1 })
  assert.equal(calls[0]?.init?.signal, undefined)
})

test("SOAP client sends pinned request with bearer auth and privacy headers", async () => {
  const calls: FetchCall[] = []
  let pacingCalls = 0
  const xml = fixtureResponse([
    fixtureWorker({ wid: "soap-worker", managerWids: [] }),
  ])
  const client = createWorkdayClient(
    baseConfig,
    staticTokenProvider(["soap-access-token"]),
    async () => {
      pacingCalls++
    },
    queuedFetch([new Response(xml, { status: 200 })], calls)
  )
  const page = await client.fetchWorkersPage(pageRequest)
  assert.equal(page.people[0]?.name, "Ada Lovelace")
  assert.equal(pacingCalls, 1)
  assert.equal(String(calls[0]?.input), baseConfig.apiUrl)
  assert.ok(calls[0]?.init?.signal instanceof AbortSignal)
  assert.equal(calls[0]?.init?.signal?.aborted, false)
  const headers = new Headers(calls[0]?.init?.headers)
  assert.deepEqual(
    {
      method: calls[0]?.init?.method,
      redirect: calls[0]?.init?.redirect,
      authorization: headers.get("authorization"),
      accept: headers.get("accept"),
      contentType: headers.get("content-type"),
      externalApplicationId: headers.get("wd-external-application-id"),
      externalRequestId: headers.get("wd-external-request-id"),
      body: calls[0]?.init?.body,
    },
    {
      method: "POST",
      redirect: "error",
      authorization: "Bearer soap-access-token",
      accept: "application/xml, text/xml",
      contentType: "text/xml; charset=utf-8",
      externalApplicationId: null,
      externalRequestId: null,
      body: buildGetWorkersRequest(baseConfig.apiVersion, pageRequest),
    }
  )
  assert.doesNotMatch(String(calls[0]?.init?.body), /soap-access-token/)
})

test("SOAP client refreshes once after 401 and retries the identical snapshot", async () => {
  const calls: FetchCall[] = []
  const invalidated: string[] = []
  let pacingCalls = 0
  const xml = fixtureResponse([fixtureWorker({ wid: "refreshed-worker" })])
  const client = createWorkdayClient(
    { ...baseConfig, externalApplicationId: "notion-workday-org-chart" },
    staticTokenProvider(["stale-token", "fresh-token"], invalidated),
    async () => {
      pacingCalls++
    },
    queuedFetch(
      [
        new Response("private expired-token detail", { status: 401 }),
        new Response(xml, { status: 200 }),
      ],
      calls
    )
  )
  const page = await client.fetchWorkersPage(pageRequest)
  assert.equal(page.people[0]?.workdayWid, "refreshed-worker")
  assert.deepEqual(invalidated, ["stale-token"])
  assert.equal(pacingCalls, 2)
  assert.deepEqual(
    calls.map((call) => new Headers(call.init?.headers).get("authorization")),
    ["Bearer stale-token", "Bearer fresh-token"]
  )
  const externalApplicationIds = calls.map((call) =>
    new Headers(call.init?.headers).get("wd-external-application-id")
  )
  assert.deepEqual(externalApplicationIds, [
    "notion-workday-org-chart",
    "notion-workday-org-chart",
  ])
  const externalRequestIds = calls.map((call) =>
    new Headers(call.init?.headers).get("wd-external-request-id")
  )
  for (const requestId of externalRequestIds) {
    assert.match(
      requestId ?? "",
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  }
  assert.notEqual(externalRequestIds[0], externalRequestIds[1])
  assert.equal(calls[0]?.init?.body, calls[1]?.init?.body)
})

test("SOAP client does not retry authorization or ordinary server errors", async () => {
  for (const status of [403, 500]) {
    const calls: FetchCall[] = []
    const privateBody = `private-${status}-body with ${baseConfig.clientSecret}`
    const client = createWorkdayClient(
      baseConfig,
      staticTokenProvider(["token"]),
      async () => {},
      queuedFetch([new Response(privateBody, { status })], calls)
    )
    const error = await captureError(() => client.fetchWorkersPage(pageRequest))
    assert.ok(error instanceof Error)
    assert.equal(error instanceof RateLimitError, false)
    assert.match(error.message, new RegExp(`failed \\(${status}\\)`))
    assert.doesNotMatch(error.message, /private|client-secret-never-log/)
    assert.equal(calls.length, 1)
  }
})

test("SOAP overload statuses and recognized 500 bodies become rate limits", async () => {
  const overloads: Array<[number, string]> = [
    [429, "anything"],
    [502, "anything"],
    [503, "anything"],
    [504, "anything"],
    [500, "Server Busy"],
    [500, "SYSTEM_UNAVAILABLE"],
    [500, "too many concurrent requests"],
    [500, "request was throttled"],
    [500, "rate-limit reached"],
  ]
  for (const [status, body] of overloads) {
    const client = createWorkdayClient(
      baseConfig,
      staticTokenProvider(["token"]),
      async () => {},
      queuedFetch([
        new Response(body, {
          status,
          headers: { "Retry-After": "9" },
        }),
      ])
    )
    const error = await captureError(() => client.fetchWorkersPage(pageRequest))
    assert.ok(error instanceof RateLimitError, `${status}: ${body}`)
    assert.equal(error.retryAfter, 9)
    assert.doesNotMatch(error.message, new RegExp(body, "i"))
  }
})

test("SOAP transport and malformed-success errors do not leak raw data", async () => {
  const cases: Array<[Response | Error, RegExp]> = [
    [
      new Error(`network path leaked ${baseConfig.clientSecret}`),
      /failed before receiving a response/,
    ],
    [new Response("<private-worker-data>", { status: 200 }), /malformed XML/],
    [
      new Response(
        '<soapenv:Envelope xmlns:soapenv="x"><soapenv:Body/></soapenv:Envelope>',
        { status: 200 }
      ),
      /missing SOAP Body|missing Get_Workers_Response/,
    ],
  ]
  for (const [response, expected] of cases) {
    const client = createWorkdayClient(
      baseConfig,
      staticTokenProvider(["access-token"]),
      async () => {},
      queuedFetch([response])
    )
    const error = await captureError(() => client.fetchWorkersPage(pageRequest))
    assert.ok(error instanceof Error)
    assert.match(error.message, expected)
    assert.doesNotMatch(
      error.message,
      /private-worker-data|client-secret-never-log|access-token/
    )
  }
})

test("SOAP rejects oversized declared bodies before parsing or leaking them", async () => {
  const privateBody = "private employee and compensation payload"
  const client = createWorkdayClient(
    baseConfig,
    staticTokenProvider(["access-token"]),
    async () => {},
    queuedFetch([
      new Response(privateBody, {
        status: 200,
        headers: {
          "Content-Length": String(WORKDAY_SOAP_MAX_RESPONSE_BYTES + 1),
        },
      }),
    ])
  )
  const error = await captureError(() => client.fetchWorkersPage(pageRequest))
  assert.ok(error instanceof Error)
  assert.equal(error instanceof RateLimitError, false)
  assert.match(error.message, /SOAP response exceeded the allowed size/)
  assert.doesNotMatch(
    error.message,
    /private|employee|compensation|access-token/
  )
})

test("SOAP client renews at most once after repeated 401 responses", async () => {
  const invalidated: string[] = []
  const client = createWorkdayClient(
    baseConfig,
    staticTokenProvider(["stale-token", "also-stale-token"], invalidated),
    async () => {},
    queuedFetch([
      new Response("first private body", { status: 401 }),
      new Response("second private body", { status: 401 }),
    ])
  )
  const error = await captureError(() => client.fetchWorkersPage(pageRequest))
  assert.ok(error instanceof Error)
  assert.equal(error instanceof RateLimitError, false)
  assert.match(
    error.message,
    /failed \(401\)|authentication failed after token renewal/
  )
  assert.doesNotMatch(error.message, /first private|second private|stale-token/)
  assert.deepEqual(invalidated, ["stale-token"])
})
