# Worker sync: Stripe

Bring Stripe customers, subscriptions, and charges into Notion for a
billing and revenue-operations view: who is a customer, what they are paying
for, and whether recent payments succeeded. The worker creates and maintains
all three databases for you, while preserving links back to the Stripe
Dashboard for day-to-day investigation.

## Quickstart

You need Node.js 22+ and a
[Stripe secret key](#getting-a-stripe-secret-key). Create one in **Stripe
Dashboard > Developers > API keys**, then run these commands from the
repository root:

```sh
npm install --global ntn
cd workers/stripe-sync
npm install
ntn login
ntn workers deploy --name stripe-sync
ntn workers env set STRIPE_API_KEY=sk_live_your-key-here
```

Preview the customers sync without writing to Notion:

```sh
ntn workers sync trigger customersSync --preview
```

Then create and populate all three databases immediately:

```sh
ntn workers sync trigger customersSync
ntn workers sync trigger subscriptionsSync
ntn workers sync trigger chargesSync
```

The worker keeps them current automatically: customers and subscriptions
every 15 minutes, charges every hour.

Everything visible to the Stripe secret key can be copied. Review the
destination databases' Notion sharing settings before giving a broader
audience access — Stripe customer and payment data is sensitive.

## What you can answer

| Managed database         | Questions it helps answer                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **Stripe Customers**     | Who is a customer? Who is delinquent or carrying a negative balance? Where are they located?                |
| **Stripe Subscriptions** | Which subscriptions are active, past due, or canceled? What is the recurring revenue per plan and interval? |
| **Stripe Charges**       | Which recent payments failed and why? How much has been refunded? What is the recent gross payment volume?  |

## Reference

### Synced databases and schedules

Three databases are maintained by three syncs, all running in `replace` mode:

| Database                 | Sync                | Mode    | Schedule     |
| ------------------------ | ------------------- | ------- | ------------ |
| **Stripe Customers**     | `customersSync`     | replace | Every 15 min |
| **Stripe Subscriptions** | `subscriptionsSync` | replace | Every 15 min |
| **Stripe Charges**       | `chargesSync`       | replace | Every hour   |

Every sync runs in `replace` mode: each run walks the complete Stripe
collection and the platform removes any previously-synced row that did not
appear in the latest run. This mirrors how Stripe itself represents deletion —
a deleted customer simply stops appearing in the list endpoint — so no
explicit `type: "delete"` change is ever emitted by this worker. Charges run
hourly rather than every 15 minutes because charge volume is typically much
higher than customer or subscription counts, and charges are immutable payment
records rather than a status you need to track in near-real time.

The databases are otherwise independent. Related resources (a subscription's
customer, a charge's customer) are stored as the raw Stripe ID in a plain text
property, not a Notion relation — the same choice linear-sync makes for team,
project, and cycle names. This keeps each database reliable on its own
schedule even if a related record hasn't synced yet.

#### Stripe Customers

| Notion property    | Stripe field                                         | Type     |
| ------------------ | ---------------------------------------------------- | -------- |
| Name               | `name`, falling back to `email`, then `id`           | title    |
| Email              | `email`                                              | email    |
| Balance            | `balance`, converted from the smallest currency unit | number   |
| Currency           | `currency`, uppercased                               | select   |
| Delinquent         | `delinquent`                                         | checkbox |
| Address            | `address`, joined into one readable line             | richText |
| Description        | `description`                                        | richText |
| Customer Link      | Stripe Dashboard URL                                 | url      |
| Created            | `created` (Unix seconds)                             | date     |
| Stripe Customer ID | `id`                                                 | richText |

Each customer page body contains the account `description`, when present.
**Balance** is a signed amount: negative means Stripe is holding a credit for
the customer, positive means the customer owes that amount on their next
invoice. See [amount and currency conversion](#amount-and-currency-conversion)
for how the smallest-unit integer is converted to a decimal number.

**Stripe Customer ID**, Stripe's immutable `cus_...` ID, is the primary key.

#### Stripe Subscriptions

| Notion property        | Stripe field                                         | Type     |
| ---------------------- | ---------------------------------------------------- | -------- |
| Title                  | first item's price `nickname`, `product`, or `id`    | title    |
| Customer               | `customer` (ID)                                      | richText |
| Status                 | `status`                                             | select   |
| Plan                   | first item's price `nickname`, `product`, or `id`    | richText |
| Amount                 | first item's `unit_amount`, converted                | number   |
| Currency               | `currency`, uppercased                               | select   |
| Billing Interval       | first item's price `recurring.interval`              | select   |
| Quantity               | first item's `quantity`                              | number   |
| Current Period Start   | subscription- or item-level period start (see below) | date     |
| Current Period End     | subscription- or item-level period end (see below)   | date     |
| Cancel At Period End   | `cancel_at_period_end`                               | checkbox |
| Canceled At            | `canceled_at`                                        | date     |
| Trial End              | `trial_end`                                          | date     |
| Subscription Link      | Stripe Dashboard URL                                 | url      |
| Stripe Subscription ID | `id`                                                 | richText |

**Status** uses Stripe's fixed subscription status enum (`incomplete`,
`incomplete_expired`, `trialing`, `active`, `past_due`, `canceled`, `unpaid`,
`paused`), so it is a `select` with predefined options rather than a
dynamically-created one.

A subscription can have multiple priced items, each billed independently.
This example surfaces the **first item** as the subscription's primary plan
to keep the schema flat and readable; see
[multi-item subscriptions](#multi-item-subscriptions) if you bill customers
with more than one item per subscription.

**Stripe Subscription ID**, Stripe's immutable `sub_...` ID, is the primary
key.

#### Stripe Charges

| Notion property  | Stripe field                    | Type     |
| ---------------- | ------------------------------- | -------- |
| Title            | `description`, or `Charge {id}` | title    |
| Customer         | `customer` (ID), when present   | richText |
| Amount           | `amount`, converted             | number   |
| Currency         | `currency`, uppercased          | select   |
| Status           | `status`                        | select   |
| Description      | `description`                   | richText |
| Refunded         | `refunded`                      | checkbox |
| Amount Refunded  | `amount_refunded`, converted    | number   |
| Failure Message  | `failure_message`               | richText |
| Date             | `created` (Unix seconds)        | date     |
| Receipt Link     | `receipt_url`, when present     | url      |
| Charge Link      | Stripe Dashboard URL            | url      |
| Stripe Charge ID | `id`                            | richText |

**Status** uses Stripe's fixed charge status enum (`succeeded`, `pending`,
`failed`).

**Stripe Charge ID**, Stripe's immutable `ch_...` ID, is the primary key.
Charges do not carry an `upstreamUpdatedAt` value: a charge's `created`
timestamp never changes even when `refunded` or `status` change later, so
using it as a freshness watermark would be misleading. This is safe because
every sync in this worker runs in `replace` mode, which diffs the full
snapshot on every run instead of relying on a watermark.

### Project structure

```text
src/
├── index.ts         — registers three managed databases and three syncs
├── stripe.ts         — REST client, starting_after pagination, rate-limit handling
├── sync-state.ts      — serializable cursor-pagination loop protection
├── customers.ts       — customer schema and transform
├── subscriptions.ts    — subscription schema and transform
├── charges.ts          — charge schema and transform
├── helpers.ts           — shared amount, date, and label formatting
└── __tests__/test.ts     — offline tests (mocked fetch, no live Stripe calls)
```

### How it works

1. All three resources use a cursor-paginated replacement sweep. Stripe's
   list endpoints return newest-first by default and don't expose an explicit
   cursor token — the next page's `starting_after` value is the **ID of the
   last object on the current page**. `src/stripe.ts` derives this after every
   request and rejects a page that reports more results but returned zero
   records, since there would be no ID to continue from.
2. Persisted cursor history (`src/sync-state.ts`) detects both an immediately
   repeated cursor and a longer cycle (`A -> B -> A`), the same safety property
   linear-sync uses for its replacement sweeps, so a pagination bug fails
   loudly instead of looping forever.
3. Every request goes through one shared pacer capped at
   **100 requests per second** — Stripe's live-mode default rate limit — via
   `worker.pacer("stripe", { allowedRequests: 100, intervalMs: 1_000 })`. The
   client also treats HTTP 429 as a rate limit and reports Stripe's
   `Retry-After` header when present, falling back to a 1-second delay
   otherwise (matching Stripe's one-second rate-limit window).
4. Since every sync runs in `replace` mode, deleted Stripe records are handled
   automatically: a deleted customer simply stops appearing in the
   `/v1/customers` list, so the next full sweep's snapshot no longer includes
   it and the platform removes the corresponding Notion row. No sync in this
   worker ever needs to emit an explicit `type: "delete"` change.

#### Amount and currency conversion

Stripe amounts are integers in the currency's smallest unit — for USD, that's
cents. `src/helpers.ts`'s `amountToDecimal()` divides by 100 for ordinary
currencies, but a small set of currencies (JPY, KRW, VND, and others) have no
smaller unit at all, so Stripe's integer amount **is** the major-unit amount
and must not be divided. The helper checks against Stripe's documented
[zero-decimal currency list](https://docs.stripe.com/currencies#zero-decimal)
before converting.

#### Subscription billing periods across API versions

Stripe API versions released on or after **2024-04-10** moved
`current_period_start`/`current_period_end` from the subscription object onto
each subscription **item**, because a subscription's items can each have an
independent billing cycle. Versions before that date only populate the
subscription-level fields. `stripe.subscriptionPeriod()` checks the
subscription-level fields first and falls back to the first item's fields, so
this worker reports a period correctly regardless of which API version your
account defaults to. `STRIPE_API_VERSION` is available (see
[configuration reference](#configuration-reference)) if you want to pin a
specific version instead of using your account's default.

#### Suggested Notion views

- **At-risk accounts:** filter Delinquent on in Customers, or Status to Past
  Due or Unpaid in Subscriptions.
- **Active recurring revenue:** filter Subscriptions to Status = Active, group
  by Billing Interval, and sum Amount.
- **Recent payment failures:** filter Charges to Status = Failed, sort by Date
  descending, and review Failure Message.
- **Refund activity:** filter Charges to Refunded on; compare Amount Refunded
  to Amount.

#### Rate limits and pagination

Stripe's default live-mode rate limit is 100 requests per second (25/second in
test mode); this worker's shared pacer is set to the live-mode ceiling. If you
are deploying against a test-mode key, lower `allowedRequests` in
`src/index.ts` to stay comfortably under 25/second.

List requests use the maximum page size Stripe allows (100 records). A
`replace`-mode sweep walks pages until `has_more` is `false`; any record
created after a sweep starts sorts before every page already fetched (Stripe
lists newest-first), so it is safely picked up on the next scheduled run
rather than appearing mid-sweep.

### Stripe access and credentials

The key's Stripe permissions define what the worker can copy.

#### Getting a Stripe secret key

1. Open the [Stripe Dashboard](https://dashboard.stripe.com/apikeys) and go to
   **Developers > API keys**.
2. Create a **restricted key** with read-only access to Customers,
   Subscriptions, and Charges — this worker never writes to Stripe, so no
   other permission is required.
3. Store it as `STRIPE_API_KEY`.

The worker sends this value as a Bearer token in the `Authorization` header.
You do not need to provide a `NOTION_API_TOKEN`; the Workers platform handles
Notion credentials.

### Configuration reference

#### Required

| Variable         | Description                                                          |
| ---------------- | -------------------------------------------------------------------- |
| `STRIPE_API_KEY` | Secret key with read access to Customers, Subscriptions, and Charges |

#### Optional

| Variable             | Description                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `STRIPE_API_VERSION` | Pin a specific [Stripe API version](https://docs.stripe.com/upgrades) instead of your account default |

For local execution, copy `.env.example` to `.env` and add your key. `.env` is
gitignored and must not be committed.

### Local verification

Run all offline tests without a Stripe connection:

```sh
npm test
```

Run a sync locally against the Stripe account accessible to the key in your
`.env` file:

```sh
ntn workers exec customersSync --local
ntn workers exec subscriptionsSync --local
ntn workers exec chargesSync --local
```

Use `--preview` when triggering a deployed sync whose returned fields you want
to inspect before writing to Notion.

### Adapting the schema

Each resource file contains both its managed-database schema and transform:

| Resource      | File                   |
| ------------- | ---------------------- |
| Customers     | `src/customers.ts`     |
| Subscriptions | `src/subscriptions.ts` |
| Charges       | `src/charges.ts`       |

To add a Stripe field:

1. Add it to the resource's type in `src/stripe.ts` (Stripe's REST response
   already includes far more fields than this worker maps; add only what you
   need to the type so the compiler catches typos).
2. Add a property with the appropriate `Schema.*` type in the resource file.
3. Add the matching `Builder.*` value in the resource transform, preserving
   schema order.
4. Add standard, minimal, and relevant edge-case assertions to
   `src/__tests__/test.ts`.

Keep the immutable Stripe ID (`cus_...`, `sub_...`, `ch_...`) as each
database's primary key.

#### Multi-item subscriptions

This example surfaces only the first subscription item as a flat "Plan" /
"Amount" / "Billing Interval" set of properties. If you bill customers with
multiple simultaneous prices per subscription, either:

- Add a `multiSelect` "Plans" property summarizing every item's product name,
  and a summed "Total Amount" number property, or
- Emit one Notion row per subscription item instead of per subscription, using
  a composite key like `${subscription.id}:${item.id}`.

#### Adding invoices or payment intents

This worker intentionally covers Customers, Subscriptions, and Charges, the
three resources requested for a billing overview. To sync Stripe Invoices or
PaymentIntents, add a new resource file following the same
schema-plus-transform pattern, a `fetch<Resource>Page` function in
`src/stripe.ts`, and a new managed database and sync in `src/index.ts`.

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [Stripe API reference](https://docs.stripe.com/api)
- [Stripe API — Pagination](https://docs.stripe.com/api/pagination)
- [Stripe API — Rate limits](https://docs.stripe.com/rate-limits)
- [Stripe — Zero-decimal currencies](https://docs.stripe.com/currencies#zero-decimal)
- [Stripe — API versioning](https://docs.stripe.com/upgrades)
- [Contributing guide](../../CONTRIBUTING.md)
