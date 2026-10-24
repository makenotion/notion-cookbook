// Schema and deterministic sample data for the in-memory demo database.
// Every INSERT uses literal values so the data is reproducible across runs.
//
// Order totals equal sum(quantity * unit_price) across their order_items rows.

export const SCHEMA_SQL = `
CREATE TABLE customers (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  email       TEXT    NOT NULL,
  country     TEXT    NOT NULL,
  signup_date TEXT    NOT NULL
);

CREATE TABLE products (
  id       INTEGER PRIMARY KEY,
  name     TEXT    NOT NULL,
  category TEXT    NOT NULL,
  price    REAL    NOT NULL
);

CREATE TABLE orders (
  id          INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  order_date  TEXT    NOT NULL,
  status      TEXT    NOT NULL,
  total       REAL    NOT NULL
);

CREATE TABLE order_items (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity   INTEGER NOT NULL,
  unit_price REAL    NOT NULL
);
`

// Row counts: customers=8, products=6, orders=15, order_items=28
//
// Per-order totals (verified: sum qty*unit_price equals orders.total):
//  1   149 = Pro(1x149)
//  2   448 = Pro(1x149) + Onboarding(1x299)
//  3    49 = Starter(1x49)
//  4   877 = Enterprise(1x499) + Export(1x79) + Onboarding(1x299)
//  5   299 = Onboarding(1x299)
//  6   228 = Pro(1x149) + Export(1x79)
//  7   499 = Enterprise(1x499)
//  8   149 = Pro(1x149)  [refunded]
//  9   997 = Enterprise(1x499) + Onboarding(1x299) + Support(1x199)
// 10   149 = Pro(1x149)
// 11  1076 = Enterprise(1x499) + Support(1x199) + Export(1x79) + Onboarding(1x299)
// 12   199 = Support(1x199)  [pending]
// 13  1155 = Enterprise(1x499) + Onboarding(1x299) + Support(1x199) + Export(2x79)
// 14   456 = Pro(2x149) + Export(2x79)
// 15    79 = Export(1x79)  [pending]

export const SEED_SQL = `
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
  (1,  1, '2024-01-10', 'completed',  149.00),
  (2,  2, '2024-01-14', 'completed',  448.00),
  (3,  3, '2024-01-22', 'completed',   49.00),
  (4,  1, '2024-02-05', 'completed',  877.00),
  (5,  4, '2024-02-11', 'completed',  299.00),
  (6,  5, '2024-02-18', 'completed',  228.00),
  (7,  6, '2024-03-02', 'completed',  499.00),
  (8,  2, '2024-03-15', 'refunded',   149.00),
  (9,  7, '2024-03-20', 'completed',  997.00),
  (10, 3, '2024-04-01', 'completed',  149.00),
  (11, 8, '2024-04-08', 'completed', 1076.00),
  (12, 1, '2024-04-22', 'pending',    199.00),
  (13, 4, '2024-05-03', 'completed', 1155.00),
  (14, 5, '2024-05-17', 'completed',  456.00),
  (15, 6, '2024-06-01', 'pending',     79.00);

INSERT INTO order_items VALUES
  -- order 1: Pro x1 = 149
  (1,  1,  2, 1, 149.00),
  -- order 2: Pro x1 + Onboarding x1 = 448
  (2,  2,  2, 1, 149.00),
  (3,  2,  4, 1, 299.00),
  -- order 3: Starter x1 = 49
  (4,  3,  1, 1,  49.00),
  -- order 4: Enterprise x1 + Export x1 + Onboarding x1 = 877
  (5,  4,  3, 1, 499.00),
  (6,  4,  5, 1,  79.00),
  (7,  4,  4, 1, 299.00),
  -- order 5: Onboarding x1 = 299
  (8,  5,  4, 1, 299.00),
  -- order 6: Pro x1 + Export x1 = 228
  (9,  6,  2, 1, 149.00),
  (10, 6,  5, 1,  79.00),
  -- order 7: Enterprise x1 = 499
  (11, 7,  3, 1, 499.00),
  -- order 8: Pro x1 = 149
  (12, 8,  2, 1, 149.00),
  -- order 9: Enterprise x1 + Onboarding x1 + Support x1 = 997
  (13, 9,  3, 1, 499.00),
  (14, 9,  4, 1, 299.00),
  (15, 9,  6, 1, 199.00),
  -- order 10: Pro x1 = 149
  (16, 10, 2, 1, 149.00),
  -- order 11: Enterprise x1 + Support x1 + Export x1 + Onboarding x1 = 1076
  (17, 11, 3, 1, 499.00),
  (18, 11, 6, 1, 199.00),
  (19, 11, 5, 1,  79.00),
  (20, 11, 4, 1, 299.00),
  -- order 12: Support x1 = 199
  (21, 12, 6, 1, 199.00),
  -- order 13: Enterprise x1 + Onboarding x1 + Support x1 + Export x2 = 1155
  (22, 13, 3, 1, 499.00),
  (23, 13, 4, 1, 299.00),
  (24, 13, 6, 1, 199.00),
  (25, 13, 5, 2,  79.00),
  -- order 14: Pro x2 + Export x2 = 456
  (26, 14, 2, 2, 149.00),
  (27, 14, 5, 2,  79.00),
  -- order 15: Export x1 = 79
  (28, 15, 5, 1,  79.00);
`
