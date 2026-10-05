# Support triage using an existing database

**Request:** “Set up a support triage queue under our Operations hub. Reuse our
Requests database if it fits. We need new requests, assigned work, and escalations.”

Fetch the hub and linked Requests database. Suppose its data source already has
`Request` (title), `State` (New, Working, Closed), `Owner` (person), and `Customer`
(relation to Accounts). Its records are support requests, not sales opportunities.

Reuse that data source. Explain that the existing title, lifecycle, owner, and
customer relation already support the workflow. If the user needs an explicit
escalation flag, add that property rather than a parallel database or copied
customer names. Do not assign owners or modify existing states without evidence.

If view creation is available, create the requested queues using actual property
identifiers: New requests filtered to New, Assigned work filtered to an assigned
owner and a non-Closed state, and Escalations filtered to the escalation flag and
a non-Closed state. These views do not restrict who can access the underlying
records. If views are unavailable, report the completed schema work and provide
the filters to set manually.

Verify schema and filters, preserve existing records and views, and return the
database and available view links. No separate proposal document is required.
