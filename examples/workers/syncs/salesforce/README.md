# Worker Sync: Salesforce

A Notion worker that one-way syncs Salesforce **Accounts** and **Opportunities** into two related managed Notion databases. Auth is via OAuth 2.0 against a Salesforce Connected App; the runtime stores and refreshes the token automatically.

## Prerequisites

- A Notion workspace where you can install workers.
- A Salesforce org you can sign in to (Developer Edition is free at <https://developer.salesforce.com/signup>).
- Salesforce **System Administrator** permission so you can create a Connected App.
- Node.js ≥ 22 and the [`ntn` CLI](https://developers.notion.com/workers/get-started/quickstart) installed.

## Step 1 — Clone and install

```zsh
git clone https://github.com/makenotion/notion-cookbook.git
cd notion-cookbook/examples/workers/syncs/salesforce
npm install
ntn login
```

## Step 2 — Create a Salesforce Connected App

1. In Salesforce, open **Setup → App Manager → New Connected App** → **Create a Connected App**.
2. Fill in **Name**, **API Name**, **Contact Email**.
3. Under **API (Enable OAuth Settings)**, check **Enable OAuth Settings**.
4. Get your worker's callback URL by running:
   ```zsh
   ntn workers oauth show-redirect-url
   ```
   Paste it into the **Callback URL** field.
5. Move these scopes into **Selected OAuth Scopes**:
   - `Manage user data via APIs (api)`
   - `Perform requests at any time (refresh_token, offline_access)`
6. Click **Save**, wait ~10 minutes for the app to propagate, then open **Manage Consumer Details** to reveal the **Consumer Key** and **Consumer Secret**.

## Step 3 — Store the credentials

```zsh
ntn workers env set SF_CLIENT_ID=<consumer-key>
ntn workers env set SF_CLIENT_SECRET=<consumer-secret>
```

## Step 4 — Deploy

```zsh
ntn workers deploy --name salesforce-sync
```

This creates two managed databases — **Salesforce Accounts** and **Salesforce Opportunities** — linked by a two-way relation (the Accounts database gets an auto-created **Opportunities** column).

## Step 5 — Authorize and backfill

Authorize the worker against your Salesforce org:

```zsh
ntn workers oauth start salesforceAuth
```

A browser window opens; sign in and approve the requested scopes.

Now run the initial backfill for both objects:

```zsh
ntn workers sync trigger accountsBackfill
ntn workers sync trigger opportunitiesBackfill
```

Within a few seconds Notion fills with rows. Each Opportunity automatically links to its Account via the relation.

## Step 6 — Verify the delta syncs

`accountsDelta` and `opportunitiesDelta` run automatically every 30 minutes. To see one happen now, edit an Account in Salesforce, then:

```zsh
ntn workers sync trigger accountsDelta
```

The row updates in Notion.

## How the code is organized

- `src/index.ts` — Worker entry. Declares OAuth, the two managed databases (with the Account ↔ Opportunities relation), a shared rate-limit pacer, and four syncs.
- `src/salesforce.ts` — REST client. Discovers the org's instance URL via `/services/oauth2/userinfo` (since `accessToken()` only returns the bearer), then exposes `soql()` and `next()` for pagination.
- `src/mapping.ts` — Pure transformation functions (`accountToUpsert`, `opportunityToUpsert`) that convert SOQL rows into Notion change records.
- `src/types.ts` — `SfAccount`, `SfOpportunity`, and the generic `SfQueryResponse<T>` shape.

The delta cycle keeps `{ since, nextRecordsUrl, maxSeen }` in state — `since` is the `LastModifiedDate` watermark, `nextRecordsUrl` paginates within a cycle, and `maxSeen` tracks the running max so the watermark advances correctly. A 30-second consistency buffer keeps us safely behind Salesforce's index.

## Customizing

- **Sync a different object** — duplicate the Opportunity-related blocks (database, SOQL fields constant, two syncs) and change the SOQL `FROM` clause and the mapper.
- **Add a custom field** — append it to the corresponding `*_FIELDS` constant in `index.ts`, extend the type in `types.ts`, and map it in `mapping.ts`. Custom field API names end in `__c` (e.g. `Account_Tier__c`).
- **Switch the API version** — bump `API_VERSION` in `salesforce.ts`.

## Troubleshooting

- **"Salesforce userinfo lookup failed: 401"** — your OAuth session is invalid. Re-run `ntn workers oauth start salesforceAuth`.
- **Backfill returns 0 records** — the Connected App user lacks read access to the object. Grant the user a profile/permission set that includes Read on Account and Opportunity.
- **Relation appears unlinked on a fresh sync** — the Opportunity's Account row hasn't been written yet. Once `accountsBackfill` completes, the relation resolves automatically; trigger `opportunitiesBackfill` once both are done if needed.
- **"invalid_grant" during oauth start** — your callback URL doesn't match. Re-copy from `ntn workers oauth show-redirect-url` into Salesforce.

## Learn more

- [Notion Workers documentation](https://developers.notion.com/workers/get-started/overview)
- [OAuth guide](https://developers.notion.com/workers/guides/oauth)
- [Syncs guide](https://developers.notion.com/workers/guides/syncs)
- [Salesforce REST API reference](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/)
- [Contribute to this cookbook](../../../../CONTRIBUTING.md)
