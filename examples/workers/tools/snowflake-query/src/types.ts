// Shape of Snowflake's SQL REST API response in synchronous mode. We
// surface a flattened view of the most-used fields; everything else on
// the response (statementHandle, sqlState, etc.) is ignored.
export interface SfStatementResponse {
  resultSetMetaData?: {
    rowType: { name: string; type: string }[]
    numRows?: number
  }
  data?: (string | null)[][]
  message?: string
  code?: string
}
