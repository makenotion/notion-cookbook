import * as Builder from "@notionhq/workers/builder"

export type CustomerRow = {
  id: unknown
  name: unknown
  email: unknown
  country: unknown
  signup_date: unknown
}

export function customerToChange(row: CustomerRow) {
  return {
    type: "upsert" as const,
    key: String(row.id),
    properties: {
      Name: Builder.title(String(row.name)),
      "Customer ID": Builder.richText(String(row.id)),
      Email: Builder.email(String(row.email)),
      Country: Builder.select(String(row.country)),
      "Signup Date": Builder.date(String(row.signup_date)),
    },
  }
}
