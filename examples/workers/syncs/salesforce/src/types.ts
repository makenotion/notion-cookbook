// We only pull the columns we display in Notion. Add a field here and
// extend the SOQL SELECT in `salesforce.ts` plus the mapper in `mapping.ts`.

export interface SfAccount {
  Id: string
  Name: string
  Industry: string | null
  Type: string | null
  Website: string | null
  Owner: { Name: string | null } | null
  LastModifiedDate: string // ISO 8601
}

export interface SfOpportunity {
  Id: string
  Name: string
  AccountId: string | null
  StageName: string | null
  Amount: number | null
  CloseDate: string | null // YYYY-MM-DD
  Owner: { Name: string | null } | null
  LastModifiedDate: string
}

// Generic shape of a Salesforce REST query response.
export interface SfQueryResponse<T> {
  totalSize: number
  done: boolean
  records: T[]
  nextRecordsUrl?: string
}
