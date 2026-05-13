import * as Builder from "@notionhq/workers/builder"
import type { SfAccount, SfOpportunity } from "./types.js"

// Salesforce → Notion field maps live here so `index.ts` stays focused on
// the worker shape. To add a field: extend the type in `types.ts`, add it
// to the SOQL SELECT in `index.ts`, and map it here.

export function accountToUpsert(account: SfAccount) {
  return {
    type: "upsert" as const,
    key: account.Id,
    properties: {
      Name: Builder.title(account.Name),
      "Account ID": Builder.richText(account.Id),
      Industry: Builder.richText(account.Industry ?? ""),
      Type: Builder.richText(account.Type ?? ""),
      Website: Builder.richText(account.Website ?? ""),
      Owner: Builder.richText(account.Owner?.Name ?? ""),
      Updated: Builder.dateTime(account.LastModifiedDate),
    },
  }
}

export function opportunityToUpsert(opp: SfOpportunity) {
  // Salesforce returns `null` for empty number fields; Notion's number
  // builder doesn't accept null, so fall back to 0 and let users tell
  // the difference via the Stage column.
  const amount = opp.Amount ?? 0

  return {
    type: "upsert" as const,
    key: opp.Id,
    properties: {
      Name: Builder.title(opp.Name),
      "Opportunity ID": Builder.richText(opp.Id),
      Stage: Builder.richText(opp.StageName ?? ""),
      Amount: Builder.number(amount),
      "Close Date": opp.CloseDate
        ? Builder.date(opp.CloseDate)
        : Builder.richText(""),
      Owner: Builder.richText(opp.Owner?.Name ?? ""),
      Updated: Builder.dateTime(opp.LastModifiedDate),
      // The relation key is the Salesforce Account ID — same value
      // used as the primary key of the `accounts` database. Notion
      // resolves the link once both rows exist; on first sync an
      // opportunity might briefly show an unresolved relation if
      // it arrives before its parent account.
      Account: opp.AccountId ? [Builder.relation(opp.AccountId)] : [],
    },
  }
}
