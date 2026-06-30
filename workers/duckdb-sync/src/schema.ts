import * as Schema from "@notionhq/workers/schema"

// The seed customers table has 8 rows with these distinct country codes:
// US, GB, CA, DE, AU, FR, SG
export const INITIAL_TITLE = "Demo Customers"
export const PRIMARY_KEY = "Customer ID"

export const customerSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  properties: {
    Name: Schema.title(),
    "Customer ID": Schema.richText(),
    Email: Schema.email(),
    Country: Schema.select([
      { name: "AU" },
      { name: "CA" },
      { name: "DE" },
      { name: "FR" },
      { name: "GB" },
      { name: "SG" },
      { name: "US" },
    ]),
    "Signup Date": Schema.date(),
  },
}
