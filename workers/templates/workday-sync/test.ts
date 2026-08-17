import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { RateLimitError } from "@notionhq/workers"

import worker from "./src/index.js"
import { directoryKey } from "./src/keys.js"
import {
  organizationSchema,
  organizationToChange,
  organizationsFromPeople,
} from "./src/organizations.js"
import {
  type DirectoryPerson,
  MAX_MANAGER_RELATIONS,
  peopleSchema,
  personToChange,
} from "./src/people.js"
import {
  DIRECTORY_FINGERPRINT_LENGTH,
  DIRECTORY_SYNC_STATE_VERSION,
  MAX_SNAPSHOT_PAGES,
  effectiveDateInTimeZone,
  runOrganizationsSyncPage,
  runPeopleSyncPage,
  snapshotRequest,
  type DirectorySyncState,
  type WorkdayDirectoryClient,
  type WorkdayPageRequest,
  type WorkdayWorkersPage,
} from "./src/sync.js"
import {
  DEFAULT_WORKDAY_WWS_VERSION,
  WORKDAY_PAGE_SIZE,
  WORKDAY_REQUEST_TIMEOUT_MS,
  WORKDAY_SOAP_MAX_RESPONSE_BYTES,
  WORKDAY_TOKEN_MAX_RESPONSE_BYTES,
  buildGetWorkContactRequest,
  buildGetWorkersRequest as buildProjectedGetWorkersRequest,
  createWorkdayClient,
  createWorkdayTokenProvider,
  getWorkdayConfig,
  parseGetWorkContactResponse,
  parseGetWorkersResponse as parseProjectedGetWorkersResponse,
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

function testWorkEmailFingerprint(email: string): string {
  return createHash("sha256")
    .update(
      `notion-workday-directory:work-email:${email.trim().toLowerCase()}`,
      "utf8"
    )
    .digest()
    .subarray(0, 8)
    .toString("base64url")
}

function testWorkerFingerprint(workdayWid: string): string {
  return createHash("sha256")
    .update(`notion-workday-directory:worker:${workdayWid.trim()}`, "utf8")
    .digest()
    .subarray(0, 8)
    .toString("base64url")
}

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

function buildPeopleWorkersRequest(
  version: string,
  request: WorkdayPageRequest
): string {
  return buildProjectedGetWorkersRequest(version, request, "people")
}

function parsePeopleWorkersResponse(xml: string): WorkdayWorkersPage {
  return parseProjectedGetWorkersResponse(xml, "people")
}

const ada: DirectoryPerson = {
  workdayWid: "wid-person-ada-private",
  name: "Ada Lovelace",
  workEmail: "ada@example.com",
  supervisoryOrganization: {
    workdayWid: "wid-organization-engineering-private",
    name: "Engineering",
  },
  managerWorkdayWids: [
    "wid-person-grace-private",
    "wid-person-alan-private",
    "wid-person-grace-private",
  ],
}

function fullPeoplePage(
  first: DirectoryPerson,
  prefix: string
): DirectoryPerson[] {
  return [
    first,
    ...Array.from({ length: WORKDAY_PAGE_SIZE - 1 }, (_, index) => ({
      ...ada,
      workdayWid: `${prefix}-worker-${index + 2}`,
      name: `${prefix} Employee ${index + 2}`,
      workEmail: undefined,
      managerWorkdayWids: [],
    })),
  ]
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
  organizationWid?: string
  organizationName?: string
  managerWids?: string[]
  managerReferences?: Array<{ wid: string; idTypes: string[] }>
  workerIdTypes?: string[]
  membershipCount?: number
  chainOrganizationWids?: string[]
  omitManagementChain?: boolean
  omitSupervisoryManagementChain?: boolean
  sensitiveData?: boolean
}

function fixtureWorker({
  wid,
  name = "Ada Lovelace",
  referenceDescriptor,
  organizationWid = "organization-engineering-wid",
  organizationName = "Engineering",
  managerWids = ["manager-grace-wid"],
  managerReferences,
  workerIdTypes = ["Employee_ID", "WID"],
  membershipCount = 1,
  chainOrganizationWids = [organizationWid],
  omitManagementChain = false,
  omitSupervisoryManagementChain = false,
  sensitiveData = false,
}: WorkerFixture): string {
  const memberships = Array.from({ length: membershipCount }, (_, index) => {
    const membershipWid =
      index === 0 ? organizationWid : `${organizationWid}-${index + 1}`
    return [
      "<bsvc:Worker_Organization_Data>",
      widReference("Organization_Reference", membershipWid, organizationName),
      "<bsvc:Organization_Data>",
      `<bsvc:Organization_Name>${organizationName}</bsvc:Organization_Name>`,
      "<bsvc:Organization_Code>sensitive-org-code</bsvc:Organization_Code>",
      "</bsvc:Organization_Data>",
      "</bsvc:Worker_Organization_Data>",
    ].join("")
  }).join("")

  const chainEntries = chainOrganizationWids
    .map((chainWid) =>
      [
        "<bsvc:Management_Chain_Data>",
        widReference("Organization_Reference", chainWid, organizationName),
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

  const personalData = sensitiveData
    ? [
        "<bsvc:Personal_Data>",
        "<bsvc:Contact_Data>",
        "<bsvc:Email_Address_Data>",
        "<bsvc:Email_Address>ada.secret@example.com</bsvc:Email_Address>",
        "</bsvc:Email_Address_Data>",
        "</bsvc:Contact_Data>",
        "<bsvc:Name_Data>private-name-structure</bsvc:Name_Data>",
        "<bsvc:Personal_Information_Data>",
        "<bsvc:National_ID>999-00-1234</bsvc:National_ID>",
        "<bsvc:Date_of_Birth>1815-12-10</bsvc:Date_of_Birth>",
        "</bsvc:Personal_Information_Data>",
        "</bsvc:Personal_Data>",
      ].join("")
    : ""

  return [
    "<bsvc:Worker>",
    typedReference("Worker_Reference", wid, workerIdTypes, referenceDescriptor),
    name ? `<bsvc:Worker_Descriptor>${name}</bsvc:Worker_Descriptor>` : "",
    "<bsvc:Worker_Data>",
    personalData,
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
          sensitiveData
            ? [
                "<bsvc:Worker_Matrix_Management_Chain_Data>",
                "<bsvc:Management_Chain_Data>",
                "<bsvc:Private_Matrix_Context>matrix-private-context</bsvc:Private_Matrix_Context>",
                "</bsvc:Management_Chain_Data>",
                "</bsvc:Worker_Matrix_Management_Chain_Data>",
              ].join("")
            : "",
          "</bsvc:Management_Chain_Data>",
        ].join(""),
    sensitiveData
      ? [
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

type ContactEmailFixture = {
  email?: string
  public?: string | boolean
  primary?: string | boolean
  usageType?: string
  includeUsageTypeId?: boolean
  emailDataCount?: number
}

function fixtureContactEmail({
  email = "ada@example.com",
  public: isPublic = true,
  primary = true,
  usageType = "WORK",
  includeUsageTypeId = true,
  emailDataCount = 1,
}: ContactEmailFixture = {}): string {
  const emailData = Array.from({ length: emailDataCount }, () =>
    email === undefined
      ? "<bsvc:Email_Data/>"
      : `<bsvc:Email_Data><bsvc:Email_Address>${email}</bsvc:Email_Address></bsvc:Email_Data>`
  ).join("")
  return [
    "<bsvc:Email_Information_Data>",
    emailData,
    `<bsvc:Usage_Data bsvc:Public="${String(isPublic)}">`,
    `<bsvc:Type_Data bsvc:Primary="${String(primary)}">`,
    "<bsvc:Type_Reference>",
    includeUsageTypeId
      ? `<bsvc:ID bsvc:type="Communication_Usage_Type_ID">${usageType}</bsvc:ID>`
      : '<bsvc:ID bsvc:type="WID">usage-type-wid</bsvc:ID>',
    "</bsvc:Type_Reference>",
    "</bsvc:Type_Data>",
    "</bsvc:Usage_Data>",
    "</bsvc:Email_Information_Data>",
  ].join("")
}

function fixtureContactPerson({
  wid,
  emails = [{}],
  changeDataCount = 1,
  sensitiveData = false,
}: {
  wid: string
  emails?: ContactEmailFixture[]
  changeDataCount?: number
  sensitiveData?: boolean
}): string {
  const changeData = Array.from({ length: changeDataCount }, () =>
    [
      "<bsvc:Change_Work_Contact_Information_Data>",
      "<bsvc:Person_Contact_Information_Data>",
      sensitiveData
        ? [
            "<bsvc:Person_Address_Information_Data>",
            "<bsvc:Address_Information_Data>",
            "<bsvc:Address_Data><bsvc:Address_Line_Data>private address</bsvc:Address_Line_Data></bsvc:Address_Data>",
            "</bsvc:Address_Information_Data>",
            "</bsvc:Person_Address_Information_Data>",
            "<bsvc:Person_Phone_Information_Data>",
            "<bsvc:Phone_Information_Data><bsvc:Phone_Data><bsvc:Phone_Number>555-private</bsvc:Phone_Number></bsvc:Phone_Data></bsvc:Phone_Information_Data>",
            "</bsvc:Person_Phone_Information_Data>",
          ].join("")
        : "",
      "<bsvc:Person_Email_Information_Data>",
      emails.map(fixtureContactEmail).join(""),
      "</bsvc:Person_Email_Information_Data>",
      "</bsvc:Person_Contact_Information_Data>",
      "</bsvc:Change_Work_Contact_Information_Data>",
    ].join("")
  ).join("")

  return [
    "<bsvc:Change_Work_Contact_Information>",
    widReference("Person_Reference", wid, "Private descriptor"),
    changeData,
    "</bsvc:Change_Work_Contact_Information>",
  ].join("")
}

function fixtureContactResponse(
  contacts: string[],
  {
    page = 1,
    totalPages = 1,
    totalResults = contacts.length,
    pageResults = contacts.length,
  }: ResponseFixture = {}
): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:bsvc="urn:com.workday/bsvc">',
    "<soapenv:Body>",
    "<bsvc:Get_Change_Work_Contact_Information_Response>",
    "<bsvc:Response_Results>",
    `<bsvc:Page>${page}</bsvc:Page>`,
    `<bsvc:Total_Pages>${totalPages}</bsvc:Total_Pages>`,
    `<bsvc:Total_Results>${totalResults}</bsvc:Total_Results>`,
    `<bsvc:Page_Results>${pageResults}</bsvc:Page_Results>`,
    "</bsvc:Response_Results>",
    `<bsvc:Response_Data>${contacts.join("")}</bsvc:Response_Data>`,
    "</bsvc:Get_Change_Work_Contact_Information_Response>",
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
    workerFingerprint: testWorkerFingerprint,
    workEmailFingerprint: testWorkEmailFingerprint,
    async fetchWorkersPage(request, _options) {
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

test("worker manifest declares organizations before people with exact schemas", () => {
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
        key: "organizations",
        type: "managed",
        title: "Workday Supervisory Organizations",
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
        properties: [
          "Name",
          "Work Email",
          "Notion Profile",
          "Supervisory Organization",
          "Supervisory Managers",
          "Directory Key",
        ],
      },
    ]
  )

  assert.deepEqual(organizationSchema.properties, {
    Name: { type: "title" },
    "Directory Key": { type: "text" },
  })
  assert.deepEqual(peopleSchema.properties, {
    Name: { type: "title" },
    "Work Email": { type: "email" },
    "Notion Profile": { type: "people" },
    "Supervisory Organization": {
      type: "relation",
      relatedDatabaseKey: "organizations",
      config: {
        twoWay: true,
        relatedPropertyName: "Organization Members",
      },
    },
    "Supervisory Managers": {
      type: "relation",
      relatedDatabaseKey: "people",
      config: { twoWay: true, relatedPropertyName: "Direct Reports" },
    },
    "Directory Key": { type: "text" },
  })
})

test("worker manifest pins replace-mode daily syncs behind one shared pacer", () => {
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
        key: "organizationsSync",
        databaseKey: "organizations",
        primaryKeyProperty: "Directory Key",
        mode: "replace",
        schedule: { type: "interval", intervalMs: 24 * 60 * 60_000 },
      },
      {
        key: "peopleSync",
        databaseKey: "people",
        primaryKeyProperty: "Directory Key",
        mode: "replace",
        schedule: { type: "interval", intervalMs: 24 * 60 * 60_000 },
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
    directoryKey("organization", "shared-wid")
  )
  assert.match(
    directoryKey("organization", "shared-wid"),
    /^wd-organization-[a-f0-9]{32}$/
  )
  assert.throws(() => directoryKey("person", "  "), /person WID is empty/)
  assert.throws(
    () => directoryKey("organization", ""),
    /organization WID is empty/
  )
})

test("person transform hashes identifiers, filters self, and emits co-managers", () => {
  const person = {
    ...ada,
    managerWorkdayWids: [ada.workdayWid, "manager-z", "manager-a", "manager-z"],
  }
  const change = personToChange(person)
  const personKey = directoryKey("person", ada.workdayWid)
  const organizationKey = directoryKey(
    "organization",
    ada.supervisoryOrganization.workdayWid
  )
  const managerKeys = [
    directoryKey("person", "manager-a"),
    directoryKey("person", "manager-z"),
  ].sort()

  assert.deepEqual(change, {
    type: "upsert",
    key: personKey,
    properties: {
      Name: [["Ada Lovelace"]],
      "Work Email": [["ada@example.com"]],
      "Notion Profile": [{ email: "ada@example.com" }],
      "Supervisory Organization": [
        { type: "primaryKey", value: organizationKey },
      ],
      "Supervisory Managers": managerKeys.map((value) => ({
        type: "primaryKey",
        value,
      })),
      "Directory Key": [[personKey]],
    },
  })
  const serialized = JSON.stringify(change)
  for (const rawWid of [
    ada.workdayWid,
    ada.supervisoryOrganization.workdayWid,
    "manager-a",
    "manager-z",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(rawWid))
  }
})

test("person transform emits an explicit empty manager relation", () => {
  const ceo = { ...ada, managerWorkdayWids: [] }
  const person = personToChange(ceo)
  assert.deepEqual(person.properties["Supervisory Managers"], [])
})

test("person transform keeps name when work email and profile are unavailable", () => {
  const person = personToChange({ ...ada, workEmail: undefined })
  assert.deepEqual(person.properties.Name, [["Ada Lovelace"]])
  assert.deepEqual(person.properties["Work Email"], [])
  assert.deepEqual(person.properties["Notion Profile"], [])
})

test("person transform enforces Notion's email property limit", () => {
  const atLimit = `${"a".repeat(188)}@example.com`
  assert.equal(atLimit.length, 200)
  assert.deepEqual(
    personToChange({ ...ada, workEmail: atLimit }).properties["Work Email"],
    [[atLimit]]
  )

  assert.throws(
    () => personToChange({ ...ada, workEmail: `a${atLimit}` }),
    /valid email address/
  )
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
    (atLimit.properties["Supervisory Managers"] as unknown[]).length,
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

test("organization transform emits only its employee-visible name and opaque key", () => {
  const change = organizationToChange({
    workdayWid: "organization-private-wid",
    name: "Platform",
  })
  assert.deepEqual(change, {
    type: "upsert",
    key: directoryKey("organization", "organization-private-wid"),
    properties: {
      Name: [["Platform"]],
      "Directory Key": [
        [directoryKey("organization", "organization-private-wid")],
      ],
    },
  })
  assert.doesNotMatch(JSON.stringify(change), /organization-private-wid/)
})

test("organization derivation dedupes by WID and validates only its name", () => {
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
      supervisoryOrganization: {
        workdayWid: "organization-accounting",
        name: "Accounting",
      },
      managerWorkdayWids: [],
    },
  ]
  assert.deepEqual(organizationsFromPeople(people), [
    {
      workdayWid: "organization-accounting",
      name: "Accounting",
    },
    {
      workdayWid: ada.supervisoryOrganization.workdayWid,
      name: "Engineering",
    },
  ])
  assert.throws(
    () =>
      organizationsFromPeople([
        ada,
        {
          ...ada,
          workdayWid: "other-person",
          supervisoryOrganization: {
            ...ada.supervisoryOrganization,
            name: "R&D",
          },
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

test("Get_Workers request enables only required directory sections", () => {
  const xml = buildPeopleWorkersRequest("v46.1", pageRequest)
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

test("Organizations projection excludes and does not require manager data", () => {
  const xml = buildProjectedGetWorkersRequest(
    "v46.1",
    pageRequest,
    "organizations"
  )
  const responseGroup = xml.match(
    /<bsvc:Response_Group>(.*?)<\/bsvc:Response_Group>/
  )?.[1]
  assert.ok(responseGroup)
  const managerFlags = leafElements(responseGroup).filter(([name]) =>
    name.includes("Management_Chain_Data")
  )
  assert.deepEqual(managerFlags, [
    ["Include_Management_Chain_Data", "false"],
    ["Include_Multiple_Managers_in_Management_Chain_Data", "false"],
  ])

  const page = parseProjectedGetWorkersResponse(
    fixtureResponse([
      fixtureWorker({
        wid: "organization-only-worker",
        omitManagementChain: true,
      }),
    ]),
    "organizations"
  )
  assert.deepEqual(page.people[0]?.managerWorkdayWids, [])
})

test("work-contact request batches exact WIDs at the pinned snapshot", () => {
  const xml = buildGetWorkContactRequest("v46.1", pageRequest, [
    "worker-one",
    "worker&two",
  ])
  assert.match(
    xml,
    /<bsvc:Get_Change_Work_Contact_Information_Request bsvc:version="v46\.1">/
  )
  assert.match(xml, /<bsvc:ID bsvc:type="WID">worker-one<\/bsvc:ID>/)
  assert.match(xml, /<bsvc:ID bsvc:type="WID">worker&amp;two<\/bsvc:ID>/)
  const filter = xml.match(
    /<bsvc:Response_Filter>(.*?)<\/bsvc:Response_Filter>/
  )?.[1]
  assert.ok(filter)
  assert.deepEqual(leafElements(filter), [
    ["As_Of_Effective_Date", pageRequest.asOfEffectiveDate],
    ["As_Of_Entry_DateTime", pageRequest.asOfEntryDateTime],
    ["Page", "1"],
    ["Count", String(WORKDAY_PAGE_SIZE)],
  ])

  for (const workdayWids of [
    [],
    ["duplicate", " duplicate "],
    [""],
    Array.from({ length: WORKDAY_PAGE_SIZE + 1 }, (_, index) => `wid-${index}`),
  ]) {
    assert.throws(
      () => buildGetWorkContactRequest("v46.1", pageRequest, workdayWids),
      /invalid worker references/
    )
  }
})

test("work-contact parser selects one public primary WORK email", () => {
  const xml = fixtureContactResponse([
    fixtureContactPerson({
      wid: "worker-ada",
      sensitiveData: true,
      emails: [
        {
          email: "home@example.com",
          public: true,
          primary: true,
          usageType: "HOME",
        },
        {
          email: "private-work@example.com",
          public: false,
          primary: true,
        },
        {
          email: "secondary@example.com",
          public: true,
          primary: false,
        },
        { email: " ADA@EXAMPLE.COM ", public: "1", primary: "1" },
      ],
    }),
    fixtureContactPerson({
      wid: "worker-grace",
      emails: [{ email: "grace@example.com" }],
    }),
  ])
  const emails = parseGetWorkContactResponse(xml, [
    "worker-ada",
    "worker-grace",
  ])
  assert.deepEqual(
    [...emails],
    [
      ["worker-ada", "ada@example.com"],
      ["worker-grace", "grace@example.com"],
    ]
  )
  assert.doesNotMatch(
    JSON.stringify([...emails]),
    /home@example|private-work@example|secondary@example|private address|555-private/
  )
})

test("work-contact parser allows no work email but fails on ambiguity", () => {
  const oneWorker = (emails: ContactEmailFixture[]) =>
    fixtureContactResponse([
      fixtureContactPerson({ wid: "worker-ada", emails }),
    ])

  for (const emails of [
    [{ email: "home@example.com", usageType: "HOME" }],
    [{ email: "work@example.com", public: false }],
    [{ email: "work@example.com", primary: false }],
  ]) {
    assert.deepEqual(
      [...parseGetWorkContactResponse(oneWorker(emails), ["worker-ada"])],
      [["worker-ada", undefined]]
    )
  }

  assert.throws(
    () =>
      parseGetWorkContactResponse(
        oneWorker([{ email: "one@example.com" }, { email: "two@example.com" }]),
        ["worker-ada"]
      ),
    /multiple public primary work email/
  )
  assert.throws(
    () =>
      parseGetWorkContactResponse(
        oneWorker([{ email: "work@example.com", public: "yes" }]),
        ["worker-ada"]
      ),
    /invalid email Public attribute/
  )
  assert.throws(
    () =>
      parseGetWorkContactResponse(
        oneWorker([{ email: "work@example.com", includeUsageTypeId: false }]),
        ["worker-ada"]
      ),
    /cannot classify a public primary email usage/
  )
})

test("work-contact parser enforces a complete one-to-one employee join", () => {
  const duplicatePerson = fixtureContactResponse([
    fixtureContactPerson({ wid: "worker-one" }),
    fixtureContactPerson({ wid: "worker-one" }),
  ])
  assert.throws(
    () =>
      parseGetWorkContactResponse(duplicatePerson, [
        "worker-one",
        "worker-two",
      ]),
    /unexpected or duplicate work contact person/
  )

  const unexpected = fixtureContactResponse([
    fixtureContactPerson({ wid: "worker-other" }),
  ])
  assert.throws(
    () => parseGetWorkContactResponse(unexpected, ["worker-one"]),
    /unexpected or duplicate work contact person/
  )

  const incomplete = fixtureContactResponse(
    [fixtureContactPerson({ wid: "worker-one" })],
    { totalResults: 2 }
  )
  assert.throws(
    () => parseGetWorkContactResponse(incomplete, ["worker-one"]),
    /incomplete work contact response/
  )
})

test("Get_Workers request validates version, page, and pinned dates", () => {
  for (const version of ["46.1", "v46", "v46.1-beta", "v 46.1"]) {
    assert.throws(
      () => buildPeopleWorkersRequest(version, pageRequest),
      /SOAP version is invalid/
    )
  }
  for (const page of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => buildPeopleWorkersRequest("v46.1", { ...pageRequest, page }),
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
        buildPeopleWorkersRequest("v46.1", {
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
        buildPeopleWorkersRequest("v46.1", {
          ...pageRequest,
          asOfEntryDateTime,
        }),
      /entry timestamp must be an ISO 8601 timestamp/
    )
  }
})

test("XML parser reads the directory allowlist and ignores nearby private data", () => {
  const xml = fixtureResponse([
    fixtureWorker({
      wid: "employee-ada-wid",
      name: "Ada Lovelace",
      referenceDescriptor: "Ada Lovelace (sensitive-employee-id)",
      organizationWid: "organization-platform-wid",
      organizationName: "Platform",
      managerWids: ["manager-z-wid", "manager-a-wid", "manager-z-wid"],
      sensitiveData: true,
    }),
  ])
  const page = parsePeopleWorkersResponse(xml)
  assert.deepEqual(page, {
    page: 1,
    totalPages: 1,
    totalResults: 1,
    people: [
      {
        workdayWid: "employee-ada-wid",
        name: "Ada Lovelace",
        supervisoryOrganization: {
          workdayWid: "organization-platform-wid",
          name: "Platform",
        },
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
    "matrix-private-context",
    "Principal Secret Keeper",
    "2020-01-02",
    "999999",
  ]) {
    assert.doesNotMatch(
      serialized,
      new RegExp(sensitiveValue.replace(/\./g, "\\."))
    )
  }
  const change = personToChange({
    ...page.people[0]!,
    workEmail: "ada@example.com",
  })
  assert.doesNotMatch(
    JSON.stringify(change),
    /employee-ada-wid|organization-platform-wid|manager-[az]-wid/
  )
})

test("XML parser supports a CEO with no manager references", () => {
  const page = parsePeopleWorkersResponse(
    fixtureResponse([
      fixtureWorker({
        wid: "ceo-wid",
        name: "Chief Executive",
        organizationWid: "executive-organization-wid",
        organizationName: "Executive Office",
        managerWids: [],
      }),
    ])
  )
  assert.deepEqual(page.people[0]?.managerWorkdayWids, [])
})

test("XML parser fails closed on unclassifiable manager references", () => {
  for (const idTypes of [
    ["WID"],
    ["Contingent_Worker_ID", "WID"],
    ["Employee_ID"],
    ["Employee_ID", "Contingent_Worker_ID", "WID"],
  ]) {
    assert.throws(
      () =>
        parsePeopleWorkersResponse(
          fixtureResponse([
            fixtureWorker({
              wid: "employee-with-unclassifiable-manager",
              managerReferences: [{ wid: "manager-wid", idTypes }],
            }),
          ])
        ),
      /unclassifiable or non-employee manager reference/
    )
  }
})

test("XML parser rejects non-employee top-level worker references", () => {
  for (const workerIdTypes of [
    ["WID"],
    ["Contingent_Worker_ID", "WID"],
    ["Employee_ID", "Contingent_Worker_ID", "WID"],
  ]) {
    assert.throws(
      () =>
        parsePeopleWorkersResponse(
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
      parsePeopleWorkersResponse(
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
      parsePeopleWorkersResponse(
        fixtureResponse([
          fixtureWorker({
            wid: "employee-with-duplicate-wids",
            workerIdTypes: ["Employee_ID", "WID", "WID"],
          }),
        ])
      ),
    /duplicate Worker_Reference ID type/
  )
})

test("XML parser rejects duplicate workers and ambiguous organization membership", () => {
  const duplicate = fixtureWorker({ wid: "duplicate-worker-wid" })
  assert.throws(
    () => parsePeopleWorkersResponse(fixtureResponse([duplicate, duplicate])),
    /duplicate employee/
  )
  assert.throws(
    () =>
      parsePeopleWorkersResponse(
        fixtureResponse([
          fixtureWorker({ wid: "no-organization-worker", membershipCount: 0 }),
        ])
      ),
    /missing Organization_Data|exactly one in-scope supervisory organization/
  )
  assert.throws(
    () =>
      parsePeopleWorkersResponse(
        fixtureResponse([
          fixtureWorker({ wid: "two-organization-worker", membershipCount: 2 }),
        ])
      ),
    /exactly one in-scope supervisory organization/
  )
})

test("XML parser requires one matching supervisory management-chain entry", () => {
  assert.throws(
    () =>
      parsePeopleWorkersResponse(
        fixtureResponse([
          fixtureWorker({
            wid: "mismatch-worker",
            organizationWid: "current-organization",
            chainOrganizationWids: ["other-organization"],
          }),
        ])
      ),
    /management chain does not match/
  )
  assert.throws(
    () =>
      parsePeopleWorkersResponse(
        fixtureResponse([
          fixtureWorker({
            wid: "duplicate-chain-worker",
            organizationWid: "current-organization",
            chainOrganizationWids: [
              "current-organization",
              "current-organization",
            ],
          }),
        ])
      ),
    /management chain does not match/
  )
  assert.throws(
    () =>
      parsePeopleWorkersResponse(
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
      parsePeopleWorkersResponse(
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
      parsePeopleWorkersResponse(
        fixtureResponse([
          fixtureWorker({
            wid: "empty-chain-worker",
            chainOrganizationWids: [],
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
  assert.throws(() => parsePeopleWorkersResponse(fault), /SOAP fault/)
  assert.throws(
    () => parsePeopleWorkersResponse("<soapenv:Envelope><"),
    /malformed XML|missing Envelope|missing SOAP Body/
  )
  assert.throws(
    () => parsePeopleWorkersResponse("not xml"),
    /malformed XML|missing Envelope/
  )
  assert.throws(
    () =>
      parsePeopleWorkersResponse(
        '<soapenv:Envelope xmlns:soapenv="x"><soapenv:Body/></soapenv:Envelope>'
      ),
    /missing SOAP Body|missing Get_Workers_Response/
  )
  assert.throws(
    () => parsePeopleWorkersResponse(fixtureResponse([])),
    /missing Response_Data|incomplete directory response/
  )
  assert.throws(
    () =>
      parsePeopleWorkersResponse(
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
      parsePeopleWorkersResponse(
        fixtureResponse([
          fixtureWorker({
            wid: "missing-organization-name",
            organizationName: "",
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
      () => parsePeopleWorkersResponse(fixtureResponse([employee], fixture)),
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
      () => parsePeopleWorkersResponse(fixtureResponse([employee], fixture)),
      /invalid (Page|Total_Pages|Total_Results|Page_Results)/
    )
  }
  assert.throws(
    () =>
      parsePeopleWorkersResponse(
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
    parsePeopleWorkersResponse(
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
      parsePeopleWorkersResponse(
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
      parsePeopleWorkersResponse(
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
      parsePeopleWorkersResponse(
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

test("packed identity state stays below its 225 KB design budget", () => {
  const maximumFingerprints = MAX_SNAPSHOT_PAGES * WORKDAY_PAGE_SIZE
  const state = {
    ...stateIdentity,
    page: MAX_SNAPSHOT_PAGES,
    asOfEntryDateTime: "2026-07-02T14:15:16.000Z",
    asOfEffectiveDate: "2026-07-02",
    totalPages: MAX_SNAPSHOT_PAGES,
    totalResults: maximumFingerprints,
    seenWorkerFingerprints: "a".repeat(
      maximumFingerprints * DIRECTORY_FINGERPRINT_LENGTH
    ),
    seenWorkEmailFingerprints: "b".repeat(
      maximumFingerprints * DIRECTORY_FINGERPRINT_LENGTH
    ),
  }
  assert.ok(Buffer.byteLength(JSON.stringify(state), "utf8") < 225_000)
})

test("people sync reuses snapshot state across pages and finalizes cleanly", async () => {
  const requests: WorkdayPageRequest[] = []
  const firstPage = fullPeoplePage(ada, "first-page")
  const secondPerson: DirectoryPerson = {
    ...ada,
    workdayWid: "wid-person-second",
    name: "Grace Hopper",
    workEmail: "grace@example.com",
  }
  const client = clientWithPages(
    [
      { page: 1, totalPages: 2, totalResults: 101, people: firstPage },
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
  assert.equal(first.changes.length, WORKDAY_PAGE_SIZE)
  assert.deepEqual(first.changes[0], personToChange(ada))
  assert.deepEqual(first.nextState, {
    ...stateIdentity,
    page: 2,
    asOfEntryDateTime: "2026-01-01T00:30:00.000Z",
    asOfEffectiveDate: "2025-12-31",
    totalPages: 2,
    totalResults: 101,
    seenWorkerFingerprints: firstPage
      .map((person) => testWorkerFingerprint(person.workdayWid))
      .join(""),
    seenWorkEmailFingerprints: testWorkEmailFingerprint("ada@example.com"),
  })
  assert.doesNotMatch(
    JSON.stringify(first.nextState),
    /wid-person-ada-private|ada@example\.com/
  )

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

test("people sync rejects duplicate work email across Workday pages", async () => {
  const firstPage = fullPeoplePage(ada, "email-page")
  const duplicateEmailPerson: DirectoryPerson = {
    ...ada,
    workdayWid: "wid-person-duplicate-email",
    workEmail: "ADA@EXAMPLE.COM",
  }
  const client = clientWithPages([
    { page: 1, totalPages: 2, totalResults: 101, people: firstPage },
    {
      page: 2,
      totalPages: 2,
      totalResults: 101,
      people: [duplicateEmailPerson],
    },
  ])
  const first = await runPeopleSyncPage(
    client,
    undefined,
    () => new Date("2026-01-01T00:30:00.000Z")
  )
  await assert.rejects(
    () => runPeopleSyncPage(client, first.nextState),
    /one public work email for multiple employees/
  )
})

test("both syncs reject one employee repeated on a later page", async () => {
  const firstPage = fullPeoplePage(ada, "duplicate-worker-page")
  const repeatedWithoutEmail = { ...ada, workEmail: undefined }

  for (const runPage of [runPeopleSyncPage, runOrganizationsSyncPage]) {
    const client = clientWithPages([
      { page: 1, totalPages: 2, totalResults: 101, people: firstPage },
      {
        page: 2,
        totalPages: 2,
        totalResults: 101,
        people: [repeatedWithoutEmail],
      },
    ])
    const first = await runPage(
      client,
      undefined,
      () => new Date("2026-01-01T00:30:00.000Z")
    )
    await assert.rejects(
      () => runPage(client, first.nextState),
      /one employee more than once/
    )
  }
})

test("both syncs reject malformed employee-fingerprint state before fetching", async () => {
  const validState = {
    ...stateIdentity,
    page: 2,
    asOfEntryDateTime: "2026-07-02T14:15:16.000Z",
    asOfEffectiveDate: "2026-07-02",
    totalPages: 2,
    totalResults: 101,
  }
  const validFingerprint = testWorkerFingerprint("one-worker")
  for (const seenWorkerFingerprints of [
    undefined,
    "short",
    "!".repeat(DIRECTORY_FINGERPRINT_LENGTH),
    validFingerprint.repeat(WORKDAY_PAGE_SIZE),
    validFingerprint,
  ]) {
    for (const runPage of [runPeopleSyncPage, runOrganizationsSyncPage]) {
      const requests: WorkdayPageRequest[] = []
      const client = clientWithPages(
        [{ page: 2, totalPages: 2, totalResults: 101, people: [ada] }],
        requests
      )
      await assert.rejects(
        () =>
          runPage(client, {
            ...validState,
            ...(seenWorkerFingerprints === undefined
              ? {}
              : { seenWorkerFingerprints }),
            ...(runPage === runPeopleSyncPage
              ? { seenWorkEmailFingerprints: "" }
              : {}),
          }),
        /invalid employee fingerprints/
      )
      assert.equal(requests.length, 0)
    }
  }
})

test("people sync rejects malformed email-fingerprint state before fetching", async () => {
  const priorPeople = fullPeoplePage(ada, "valid-state-page")
  const validState = {
    ...stateIdentity,
    page: 2,
    asOfEntryDateTime: "2026-07-02T14:15:16.000Z",
    asOfEffectiveDate: "2026-07-02",
    totalPages: 2,
    totalResults: 101,
    seenWorkerFingerprints: priorPeople
      .map((person) => testWorkerFingerprint(person.workdayWid))
      .join(""),
  }
  for (const seenWorkEmailFingerprints of [
    undefined,
    "short",
    "!".repeat(DIRECTORY_FINGERPRINT_LENGTH),
    testWorkEmailFingerprint("ada@example.com").repeat(2),
  ]) {
    const requests: WorkdayPageRequest[] = []
    const client = clientWithPages(
      [{ page: 2, totalPages: 2, totalResults: 101, people: [ada] }],
      requests
    )
    await assert.rejects(
      () =>
        runPeopleSyncPage(client, {
          ...validState,
          ...(seenWorkEmailFingerprints === undefined
            ? {}
            : { seenWorkEmailFingerprints }),
        }),
      /invalid work-email fingerprints/
    )
    assert.equal(requests.length, 0)
  }
})

test("organization sync publishes one deterministic change per page", async () => {
  const teammate = { ...ada, workdayWid: "other-person" }
  const client = clientWithPages([
    { page: 1, totalPages: 1, totalResults: 2, people: [teammate, ada] },
  ])
  const result = await runOrganizationsSyncPage(
    client,
    undefined,
    () => new Date("2026-07-02T14:15:16Z")
  )
  assert.deepEqual(result, {
    changes: [
      organizationToChange({
        workdayWid: ada.supervisoryOrganization.workdayWid,
        name: ada.supervisoryOrganization.name,
      }),
    ],
    hasMore: false,
  })
})

test("sync rejects wrong pages, drifting totals, empty pages, and page overflow", async () => {
  const priorPeople = fullPeoplePage(ada, "prior-page")
  const currentPeople = fullPeoplePage(
    { ...ada, workdayWid: "current-page-first" },
    "current-page"
  )
  const state: DirectorySyncState = {
    ...stateIdentity,
    page: 2,
    asOfEntryDateTime: "2026-07-02T14:15:16.000Z",
    asOfEffectiveDate: "2026-07-02",
    totalPages: 3,
    totalResults: 201,
    seenWorkerFingerprints: priorPeople
      .map((person) => testWorkerFingerprint(person.workdayWid))
      .join(""),
    seenWorkEmailFingerprints: "",
  }
  const failures: Array<[WorkdayWorkersPage, RegExp]> = [
    [
      { page: 1, totalPages: 3, totalResults: 201, people: currentPeople },
      /different page than requested/,
    ],
    [
      { page: 2, totalPages: 4, totalResults: 201, people: currentPeople },
      /incomplete directory snapshot/,
    ],
    [
      { page: 2, totalPages: 3, totalResults: 202, people: currentPeople },
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
        people: currentPeople,
      },
      /incomplete directory snapshot/,
    ],
    [
      { page: 2, totalPages: 1, totalResults: 201, people: currentPeople },
      /incomplete directory snapshot/,
    ],
    [
      { page: 2, totalPages: 0, totalResults: 201, people: currentPeople },
      /totalPages must be a positive integer/,
    ],
    [
      { page: 2, totalPages: 3, totalResults: 0, people: currentPeople },
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
    { ...baseConfig, clientSecret: "rotated-client-secret" },
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

test("directory fingerprints are keyed, normalized, and domain separated", () => {
  const client = createWorkdayClient(
    baseConfig,
    staticTokenProvider(["unused-token"]),
    async () => {},
    queuedFetch([])
  )
  const emailFingerprint = client.workEmailFingerprint("ada@example.com")
  const workerFingerprint = client.workerFingerprint("ada@example.com")
  assert.equal(
    client.workEmailFingerprint(" ADA@EXAMPLE.COM "),
    emailFingerprint
  )
  assert.equal(client.workerFingerprint(" ada@example.com "), workerFingerprint)
  assert.match(
    emailFingerprint,
    new RegExp(`^[A-Za-z0-9_-]{${DIRECTORY_FINGERPRINT_LENGTH}}$`)
  )
  assert.notEqual(workerFingerprint, emailFingerprint)
  const rotatedClient = createWorkdayClient(
    { ...baseConfig, clientSecret: "rotated-client-secret" },
    staticTokenProvider(["unused-token"]),
    async () => {},
    queuedFetch([])
  )
  assert.notEqual(
    rotatedClient.workEmailFingerprint("ada@example.com"),
    emailFingerprint
  )
  assert.notEqual(
    rotatedClient.workerFingerprint("ada@example.com"),
    workerFingerprint
  )
  assert.throws(() => client.workerFingerprint(" "), /WID is empty/)
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
            fixtureWorker({
              wid: "page-one-worker",
              omitManagementChain: true,
            }),
          ]),
          { status: 200 }
        ),
      ],
      calls
    )
  )

  await client.fetchWorkersPage(
    { ...pageRequest, page: 1 },
    { projection: "organizations" }
  )
  assert.equal(calls[0]?.init?.signal, undefined)
})

test("SOAP client sends pinned request with bearer auth and privacy headers", async () => {
  const calls: FetchCall[] = []
  let pacingCalls = 0
  const xml = fixtureResponse([
    fixtureWorker({ wid: "soap-worker", omitManagementChain: true }),
  ])
  const client = createWorkdayClient(
    baseConfig,
    staticTokenProvider(["soap-access-token"]),
    async () => {
      pacingCalls++
    },
    queuedFetch([new Response(xml, { status: 200 })], calls)
  )
  const page = await client.fetchWorkersPage(pageRequest, {
    projection: "organizations",
  })
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
      body: buildProjectedGetWorkersRequest(
        baseConfig.apiVersion,
        pageRequest,
        "organizations"
      ),
    }
  )
  assert.doesNotMatch(String(calls[0]?.init?.body), /soap-access-token/)
})

test("People page batches and joins public work email before emitting changes", async () => {
  const calls: FetchCall[] = []
  let pacingCalls = 0
  const workersXml = fixtureResponse([
    fixtureWorker({ wid: "worker-with-email", managerWids: [] }),
  ])
  const contactsXml = fixtureContactResponse([
    fixtureContactPerson({
      wid: "worker-with-email",
      emails: [{ email: " PERSON@EXAMPLE.COM " }],
    }),
  ])
  const client = createWorkdayClient(
    baseConfig,
    staticTokenProvider(["soap-access-token"]),
    async () => {
      pacingCalls++
    },
    queuedFetch(
      [
        new Response(workersXml, { status: 200 }),
        new Response(contactsXml, { status: 200 }),
      ],
      calls
    )
  )

  const page = await client.fetchWorkersPage(pageRequest, {
    projection: "people",
  })
  assert.equal(page.people[0]?.workEmail, "person@example.com")
  assert.equal(pacingCalls, 2)
  assert.equal(calls.length, 2)
  assert.equal(
    calls[1]?.init?.body,
    buildGetWorkContactRequest(baseConfig.apiVersion, pageRequest, [
      "worker-with-email",
    ])
  )
  assert.ok(calls[1]?.init?.signal instanceof AbortSignal)
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
  const page = await client.fetchWorkersPage(pageRequest, {
    projection: "organizations",
  })
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
    const error = await captureError(() =>
      client.fetchWorkersPage(pageRequest, { projection: "organizations" })
    )
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
    const error = await captureError(() =>
      client.fetchWorkersPage(pageRequest, { projection: "organizations" })
    )
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
    const error = await captureError(() =>
      client.fetchWorkersPage(pageRequest, { projection: "organizations" })
    )
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
  const error = await captureError(() =>
    client.fetchWorkersPage(pageRequest, { projection: "organizations" })
  )
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
  const error = await captureError(() =>
    client.fetchWorkersPage(pageRequest, { projection: "organizations" })
  )
  assert.ok(error instanceof Error)
  assert.equal(error instanceof RateLimitError, false)
  assert.match(
    error.message,
    /failed \(401\)|authentication failed after token renewal/
  )
  assert.doesNotMatch(error.message, /first private|second private|stale-token/)
  assert.deepEqual(invalidated, ["stale-token"])
})
