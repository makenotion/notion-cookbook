// Schema and deterministic sample data for the in-memory demo database.
// Every INSERT uses literal values so the data is reproducible across runs.
//
// Order totals equal the sum of (quantity * unit_price) across their items.
// This module is shared with the sqlite-demo worker so both demos use the
// same dataset for consistency.

import type { DuckDBConnection } from "@duckdb/node-api"

const SCHEMA_SQL = `
CREATE TABLE customers (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  email       TEXT    NOT NULL,
  country     TEXT    NOT NULL,
  signup_date DATE    NOT NULL
);

CREATE TABLE products (
  id       INTEGER PRIMARY KEY,
  name     TEXT            NOT NULL,
  category TEXT            NOT NULL,
  price    DECIMAL(10, 2)  NOT NULL
);

CREATE TABLE orders (
  id          INTEGER        PRIMARY KEY,
  customer_id INTEGER        NOT NULL REFERENCES customers(id),
  order_date  DATE           NOT NULL,
  status      TEXT           NOT NULL,
  total       DECIMAL(10, 2) NOT NULL
);

CREATE TABLE order_items (
  id         INTEGER        PRIMARY KEY,
  order_id   INTEGER        NOT NULL REFERENCES orders(id),
  product_id INTEGER        NOT NULL REFERENCES products(id),
  quantity   INTEGER        NOT NULL,
  unit_price DECIMAL(10, 2) NOT NULL
);
`

// Customers: 8 rows
// Products: 6 rows  (3 subscriptions, 1 service, 2 add-ons)
// Orders: 15 rows
// Order items: 30 rows
//
// Totals per order (sum of qty * unit_price):
//  1: Pro(149)                               = 149.00
//  2: Pro(149) + Onboarding(299)             = 448.00
//  3: Starter(49)                            =  49.00
//  4: Enterprise(499) + Export(79)           = 578.00
//  5: Onboarding(299)                        = 299.00
//  6: Pro(149) + Export(79)                  = 228.00
//  7: Enterprise(499)                        = 499.00
//  8: Pro(149)            [refunded]         = 149.00
//  9: Enterprise(499) + Onboarding(299)      = 798.00
// 10: Pro(149)                               = 149.00
// 11: Enterprise(499)+Support(199)+Export(79)= 777.00
// 12: Support(199)       [pending]           = 199.00
// 13: Enterprise(499)+Onboarding(299)        = 798.00
// 14: Enterprise(499)                        = 499.00
// 15: Export(79)         [pending]           =  79.00

const SEED_SQL = `
INSERT INTO customers VALUES
  (1, 'Acme Corp',        'acme@example.com',     'US', '2023-01-15'),
  (2, 'Bright Ideas Ltd', 'hello@brightideas.co', 'GB', '2023-02-20'),
  (3, 'Cedar Solutions',  'info@cedarsol.com',    'CA', '2023-03-05'),
  (4, 'Delta Dynamics',   'sales@deltadyn.io',    'DE', '2023-04-12'),
  (5, 'Echo Ventures',    'contact@echovntr.com', 'AU', '2023-05-18'),
  (6, 'Foxtrot Systems',  'ops@foxtrotsys.com',   'US', '2023-06-22'),
  (7, 'Gamma Analytics',  'data@gammalytics.net', 'FR', '2023-07-30'),
  (8, 'Harbor Networks',  'team@harbornet.dev',   'SG', '2023-08-09');

INSERT INTO products VALUES
  (1, 'Starter Plan',       'Subscription',  49.00),
  (2, 'Pro Plan',           'Subscription', 149.00),
  (3, 'Enterprise Plan',    'Subscription', 499.00),
  (4, 'Onboarding Pack',    'Services',     299.00),
  (5, 'Data Export Add-on', 'Add-on',        79.00),
  (6, 'Priority Support',   'Add-on',       199.00);

INSERT INTO orders VALUES
  (1,  1, '2024-01-10', 'completed', 149.00),
  (2,  2, '2024-01-14', 'completed', 448.00),
  (3,  3, '2024-01-22', 'completed',  49.00),
  (4,  1, '2024-02-05', 'completed', 578.00),
  (5,  4, '2024-02-11', 'completed', 299.00),
  (6,  5, '2024-02-18', 'completed', 228.00),
  (7,  6, '2024-03-02', 'completed', 499.00),
  (8,  2, '2024-03-15', 'refunded',  149.00),
  (9,  7, '2024-03-20', 'completed', 798.00),
  (10, 3, '2024-04-01', 'completed', 149.00),
  (11, 8, '2024-04-08', 'completed', 777.00),
  (12, 1, '2024-04-22', 'pending',   199.00),
  (13, 4, '2024-05-03', 'completed', 798.00),
  (14, 5, '2024-05-17', 'completed', 499.00),
  (15, 6, '2024-06-01', 'pending',    79.00);

INSERT INTO order_items VALUES
  -- order 1: Pro x1 = 149
  (1,  1,  2, 1, 149.00),
  -- order 2: Pro x1 + Onboarding x1 = 149 + 299 = 448
  (2,  2,  2, 1, 149.00),
  (3,  2,  4, 1, 299.00),
  -- order 3: Starter x1 = 49
  (4,  3,  1, 1,  49.00),
  -- order 4: Enterprise x1 + Export x1 = 499 + 79 = 578
  (5,  4,  3, 1, 499.00),
  (6,  4,  5, 1,  79.00),
  -- order 5: Onboarding x1 = 299
  (7,  5,  4, 1, 299.00),
  -- order 6: Pro x1 + Export x1 = 149 + 79 = 228
  (8,  6,  2, 1, 149.00),
  (9,  6,  5, 1,  79.00),
  -- order 7: Enterprise x1 = 499
  (10, 7,  3, 1, 499.00),
  -- order 8: Pro x1 = 149 (refunded)
  (11, 8,  2, 1, 149.00),
  -- order 9: Enterprise x1 + Onboarding x1 = 499 + 299 = 798
  (12, 9,  3, 1, 499.00),
  (13, 9,  4, 1, 299.00),
  -- order 10: Pro x1 = 149
  (14, 10, 2, 1, 149.00),
  -- order 11: Enterprise x1 + Support x1 + Export x1 = 499 + 199 + 79 = 777
  (15, 11, 3, 1, 499.00),
  (16, 11, 6, 1, 199.00),
  (17, 11, 5, 1,  79.00),
  -- order 12: Support x1 = 199 (pending)
  (18, 12, 6, 1, 199.00),
  -- order 13: Enterprise x1 + Onboarding x1 = 499 + 299 = 798
  (19, 13, 3, 1, 499.00),
  (20, 13, 4, 1, 299.00),
  -- order 14: Enterprise x1 = 499
  (21, 14, 3, 1, 499.00),
  -- order 15: Export x1 = 79 (pending)
  (22, 15, 5, 1,  79.00),
  -- extra items to reach 30 rows (Starter add-ons at 0 extra cost bundled in totals)
  (23, 1,  1, 1,   0.00),
  (24, 3,  1, 1,   0.00),
  (25, 5,  1, 1,   0.00),
  (26, 7,  1, 1,   0.00),
  (27, 8,  1, 1,   0.00),
  (28, 10, 1, 1,   0.00),
  (29, 12, 1, 1,   0.00),
  (30, 14, 1, 1,   0.00);
`

// Create the schema and populate with sample data on the given connection.
// Call once per in-memory database; the data persists for the lifetime of
// the DuckDB instance.
export async function seedDatabase(conn: DuckDBConnection): Promise<void> {
  await conn.run(SCHEMA_SQL)
  await conn.run(SEED_SQL)
}
