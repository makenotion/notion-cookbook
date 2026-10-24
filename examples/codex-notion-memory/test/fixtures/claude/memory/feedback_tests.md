---
name: integration-tests-real-db
description: 'Integration tests must hit a "real" database, not mocks'
type: feedback
---

Don't mock the database in integration tests.

**Why:** a mocked test passed last quarter while the real migration failed.
**How to apply:** use the local Postgres from `docker compose up db`.
