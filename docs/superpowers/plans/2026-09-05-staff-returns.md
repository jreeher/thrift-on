# Staff-Processed Returns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff process a return for any item picked up within the last 7 days, refunding the customer correctly (card and/or store credit) and guaranteeing the item's donor never receives a payout for it.

**Architecture:** A new `lib/returns.js` holds all the logic (eligible-order lookup, search, the pure refund/credit-split math, and the transactional `processReturn`), following this codebase's existing `lib/fulfillment.js` pattern. A new staff page (`/staff/returns`) exposes it. One migration adds three columns; no new item status is needed since a returned item simply leaves `picked_up` (landing on `active` or `removed`), which already excludes it from the consignment-payout job's `WHERE status = 'picked_up'` guard.

**Tech Stack:** Node.js, Express, PostgreSQL (`pg`), EJS, Stripe.

**Reference:** Full design rationale is in `docs/superpowers/specs/2026-09-05-staff-returns-design.md`. Read it first if anything below is unclear.

**A note on testing in this codebase:** there is no local database available in this environment. Following this repo's existing convention (see `test/consignment-payout.test.js`, `test/cart-concurrency.test.js`), any test that needs a real Postgres connection is written in full but is *not* run as part of this plan or wired into `npm test` — it's verified with `node -c` (syntax only) and run manually later (e.g. via `railway ssh` against a real database) when the person doing that has one available. Pure-logic tests that need no database (like the one in Task 3) *are* run as part of this plan and wired into `npm test`, matching `test/issue-consignment-payouts-idempotency.test.js`.

---

### Task 1: Schema — add columns and the new item transition

**Files:**
- Create: `db/migrations/008_add_returns.sql`
- Modify: `db/transitions.js:10-19`

- [ ] **Step 1: Write the migration**

Create `db/migrations/008_add_returns.sql`:

```sql
-- returned_at is a permanent record that an item was sold and then returned, independent
-- of whatever status it lands in afterward (active if relisted, removed if not) — without
-- it, relisting would silently erase the fact that this item came back once.
ALTER TABLE items ADD COLUMN returned_at TIMESTAMPTZ;
ALTER TABLE items ADD COLUMN return_reason TEXT;

-- Accumulates as returns are processed against an order, the same role
-- captured_amount_cents already plays for captures — this is what lets the refund math in
-- lib/returns.js stay correct across multiple returns from the same multi-item order.
ALTER TABLE orders ADD COLUMN refunded_amount_cents INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Add the new valid transition**

In `db/transitions.js`, the `VALID_TRANSITIONS` array currently reads:

```js
const VALID_TRANSITIONS = [
  ['draft', 'active'],
  ['active', 'reserved'],
  ['reserved', 'active'],
  ['reserved', 'sold_pending_pull'],
  ['sold_pending_pull', 'pulled'],
  ['pulled', 'picked_up'],
  ['pulled', 'active'],
  ['active', 'expired']
];
```

Change it to add one entry for the relist path (`picked_up → removed` already works via the existing "anything can go to removed" rule below this array, so nothing else is needed):

```js
const VALID_TRANSITIONS = [
  ['draft', 'active'],
  ['active', 'reserved'],
  ['reserved', 'active'],
  ['reserved', 'sold_pending_pull'],
  ['sold_pending_pull', 'pulled'],
  ['pulled', 'picked_up'],
  ['pulled', 'active'],
  ['active', 'expired'],
  ['picked_up', 'active']
];
```

- [ ] **Step 3: Verify syntax**

Run: `node -c db/transitions.js`
Expected: no output (success).

The migration itself can't be run in this environment (no local `DATABASE_URL`) — it will be applied later via `railway ssh --service thrift-on -- npm run migrate` once this work is pushed.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/008_add_returns.sql db/transitions.js
git commit -m "Add returns schema: item return tracking, order refund tracking, relist transition"
```

---

### Task 2: `lib/stripe.js` — add `createRefund`

**Files:**
- Modify: `lib/stripe.js:73-79`

- [ ] **Step 1: Add the function**

The end of `lib/stripe.js` currently reads:

```js
// Releases the entire held authorization without ever charging anything — used when a
// customer ends up declining every item on an order, so there's nothing left to capture.
async function cancelPaymentIntent(paymentIntentId) {
  return getClient().paymentIntents.cancel(paymentIntentId);
}

module.exports = { getClient, createCheckoutSession, capturePaymentIntent, cancelPaymentIntent };
```

Change it to:

```js
// Releases the entire held authorization without ever charging anything — used when a
// customer ends up declining every item on an order, so there's nothing left to capture.
async function cancelPaymentIntent(paymentIntentId) {
  return getClient().paymentIntents.cancel(paymentIntentId);
}

// A partial refund against an already-captured PaymentIntent — used by lib/returns.js for
// the card portion of a processed return. Stripe rejects a request for more than what's
// actually still capturable/refunded, so the caller (computeReturnSplit) is responsible
// for never asking for more than what's left.
async function createRefund(paymentIntentId, amountCents) {
  return getClient().refunds.create({ payment_intent: paymentIntentId, amount: amountCents });
}

module.exports = {
  getClient,
  createCheckoutSession,
  capturePaymentIntent,
  cancelPaymentIntent,
  createRefund
};
```

> **Post-implementation amendment:** code review of Task 5 found that `createRefund` needed a Stripe idempotency key to make a duplicate call (e.g. a double-click on the return button) a safe no-op rather than a second real refund. The shipped signature is `createRefund(paymentIntentId, amountCents, idempotencyKey)`, passing `{ idempotencyKey }` as Stripe's request-options argument when provided. See Task 5's amendment note for the call site.

- [ ] **Step 2: Verify syntax**

Run: `node -c lib/stripe.js`
Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add lib/stripe.js
git commit -m "Add createRefund for partial Stripe refunds on returns"
```

---

### Task 3: `lib/returns.js` — `computeReturnSplit` (TDD)

This is the one piece of pure logic in this feature — no database, no Stripe — so it gets a real test-first pass.

**Files:**
- Create: `test/return-split.test.js`
- Create: `lib/returns.js`

- [ ] **Step 1: Write the failing test**

Create `test/return-split.test.js`:

```js
// Verifies the pure refund/credit-split math used by lib/returns.js's processReturn.
// No database or Stripe involved — this is plain arithmetic over three cases:
// a normal all-card order, an order with partial store credit applied, and an order
// fully covered by store credit (nothing left on the card at all).
//
// Run with: node test/return-split.test.js
const assert = require('assert');
const { computeReturnSplit } = require('../lib/returns');

function run() {
  // All-card order: remaining capture is more than enough to cover this item in full.
  assert.deepStrictEqual(
    computeReturnSplit(2000, 5000),
    { cardRefundCents: 2000, shortfallCents: 0 },
    'should refund the full item price when enough capture remains'
  );

  // Partial credit applied: remaining capture only covers part of this item's price.
  assert.deepStrictEqual(
    computeReturnSplit(2000, 500),
    { cardRefundCents: 500, shortfallCents: 1500 },
    'should refund what remains on the card and shortfall the rest'
  );

  // Fully credit-covered order: nothing was ever captured, so nothing can be refunded to
  // the card — the entire item price becomes a credit shortfall.
  assert.deepStrictEqual(
    computeReturnSplit(2000, 0),
    { cardRefundCents: 0, shortfallCents: 2000 },
    'should shortfall the entire item price when nothing remains on the card'
  );

  console.log('PASS: computeReturnSplit correctly splits card refund vs. credit shortfall in all three cases.');
}

try {
  run();
  process.exit(0);
} catch (err) {
  console.error('FAIL:', err.message);
  process.exit(1);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/return-split.test.js`
Expected: `FAIL: Cannot find module '../lib/returns'` (the file doesn't exist yet).

- [ ] **Step 3: Create `lib/returns.js` with just this function**

Create `lib/returns.js`:

```js
const pool = require('../db/pool');
const { transitionItem } = require('../db/transitions');
const { createRefund } = require('./stripe');

// Items are eligible for return for 7 days after pickup — matches
// jobs/issue-consignment-payouts.js's RETURN_WINDOW_DAYS.
const RETURN_WINDOW_DAYS = 7;

// The pure card/credit split, factored out so it can be tested without a database.
// remainingRefundableCents is orders.captured_amount_cents - orders.refunded_amount_cents,
// already clamped to >= 0 by the caller.
function computeReturnSplit(itemPriceCents, remainingRefundableCents) {
  const cardRefundCents = Math.min(itemPriceCents, remainingRefundableCents);
  const shortfallCents = itemPriceCents - cardRefundCents;
  return { cardRefundCents, shortfallCents };
}

module.exports = {
  RETURN_WINDOW_DAYS,
  computeReturnSplit
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node test/return-split.test.js`
Expected: `PASS: computeReturnSplit correctly splits card refund vs. credit shortfall in all three cases.`

- [ ] **Step 5: Wire it into `npm test`**

In `package.json`, the `scripts` section currently reads:

```json
    "test:markdown": "node test/markdown-idempotency.test.js",
    "test:purge-photos": "node test/purge-photos-idempotency.test.js",
    "test:issue-consignment-payouts": "node test/issue-consignment-payouts-idempotency.test.js",
    "test": "npm run test:markdown && npm run test:purge-photos && npm run test:issue-consignment-payouts"
```

Change it to:

```json
    "test:markdown": "node test/markdown-idempotency.test.js",
    "test:purge-photos": "node test/purge-photos-idempotency.test.js",
    "test:issue-consignment-payouts": "node test/issue-consignment-payouts-idempotency.test.js",
    "test:return-split": "node test/return-split.test.js",
    "test": "npm run test:markdown && npm run test:purge-photos && npm run test:issue-consignment-payouts && npm run test:return-split"
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all four PASS lines, ending with `PASS: computeReturnSplit correctly splits card refund vs. credit shortfall in all three cases.`

- [ ] **Step 7: Commit**

```bash
git add lib/returns.js test/return-split.test.js package.json
git commit -m "Add computeReturnSplit with test coverage"
```

---

### Task 4: `lib/returns.js` — eligible-order lookup and search

**Files:**
- Modify: `lib/returns.js`

- [ ] **Step 1: Add the lookup/search functions**

`lib/returns.js` currently ends with:

```js
module.exports = {
  RETURN_WINDOW_DAYS,
  computeReturnSplit
};
```

Change the whole file to:

```js
const pool = require('../db/pool');
const { transitionItem } = require('../db/transitions');
const { createRefund } = require('./stripe');

// Items are eligible for return for 7 days after pickup — matches
// jobs/issue-consignment-payouts.js's RETURN_WINDOW_DAYS.
const RETURN_WINDOW_DAYS = 7;

function isWithinReturnWindow(pickedUpAt) {
  if (!pickedUpAt) return false;
  const elapsedMs = Date.now() - new Date(pickedUpAt).getTime();
  return elapsedMs <= RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

// Shared by getReturnEligibleOrders and searchOrdersForReturn — both run the same
// order+item join and just need the rows grouped by order, with each item's own
// eligibility computed the same way processReturn re-derives it server-side.
function groupOrderRows(rows) {
  const ordersById = new Map();

  for (const row of rows) {
    if (!ordersById.has(row.order_id)) {
      ordersById.set(row.order_id, {
        orderId: row.order_id,
        orderNumber: row.order_number,
        customerName: row.customer_name,
        customerPhone: row.customer_phone,
        items: []
      });
    }

    ordersById.get(row.order_id).items.push({
      id: row.item_id,
      title: row.title,
      photoUrl: row.photo_url,
      binNumber: row.bin_number,
      status: row.item_status,
      eligible: row.item_status === 'picked_up' && isWithinReturnWindow(row.picked_up_at)
    });
  }

  return Array.from(ordersById.values());
}

const ORDER_ITEM_SELECT = `
  SELECT o.id AS order_id, o.order_number, o.customer_name, o.customer_phone,
         i.id AS item_id, i.title, i.photo_url, i.bin_number,
         i.status AS item_status, i.picked_up_at
    FROM orders o
    JOIN items i ON i.order_id = o.id
`;

// The Returns page's default view — orders with at least one item still inside its
// 7-day return window, most recently picked up first.
async function getReturnEligibleOrders() {
  const { rows } = await pool.query(
    `${ORDER_ITEM_SELECT}
     WHERE i.status = 'picked_up'
       AND i.picked_up_at >= NOW() - ($1 * INTERVAL '1 day')
     ORDER BY i.picked_up_at DESC, o.id ASC, i.id ASC`,
    [RETURN_WINDOW_DAYS]
  );

  return groupOrderRows(rows);
}

// Looks up an order by phone or order number, any age — this is a lookup only, it doesn't
// filter by eligibility, so staff can always find and see an order even if nothing on it
// is actionable anymore. Eligibility is enforced only when a return is actually processed.
async function searchOrdersForReturn(query) {
  const trimmed = (query || '').trim();
  if (!trimmed) return [];

  const digitsOnly = trimmed.replace(/\D/g, '');

  const { rows } =
    digitsOnly.length >= 7
      ? await pool.query(`${ORDER_ITEM_SELECT} WHERE o.customer_phone = $1 ORDER BY o.id DESC, i.id ASC`, [
          digitsOnly
        ])
      : await pool.query(
          `${ORDER_ITEM_SELECT} WHERE UPPER(o.order_number) = UPPER($1) ORDER BY o.id DESC, i.id ASC`,
          [trimmed]
        );

  return groupOrderRows(rows);
}

// The pure card/credit split, factored out so it can be tested without a database.
// remainingRefundableCents is orders.captured_amount_cents - orders.refunded_amount_cents,
// already clamped to >= 0 by the caller.
function computeReturnSplit(itemPriceCents, remainingRefundableCents) {
  const cardRefundCents = Math.min(itemPriceCents, remainingRefundableCents);
  const shortfallCents = itemPriceCents - cardRefundCents;
  return { cardRefundCents, shortfallCents };
}

module.exports = {
  RETURN_WINDOW_DAYS,
  isWithinReturnWindow,
  getReturnEligibleOrders,
  searchOrdersForReturn,
  computeReturnSplit
};
```

- [ ] **Step 2: Verify syntax**

Run: `node -c lib/returns.js`
Expected: no output (success).

- [ ] **Step 3: Re-run the pure test to make sure nothing broke**

Run: `node test/return-split.test.js`
Expected: `PASS: computeReturnSplit correctly splits card refund vs. credit shortfall in all three cases.`

- [ ] **Step 4: Commit**

```bash
git add lib/returns.js
git commit -m "Add getReturnEligibleOrders and searchOrdersForReturn"
```

---

### Task 5: `lib/returns.js` — `processReturn`

**Files:**
- Modify: `lib/returns.js`

- [ ] **Step 1: Add `processReturn`**

`lib/returns.js` currently ends with:

```js
module.exports = {
  RETURN_WINDOW_DAYS,
  isWithinReturnWindow,
  getReturnEligibleOrders,
  searchOrdersForReturn,
  computeReturnSplit
};
```

Change it to (this inserts `processReturn` above `module.exports` and adds it to the exports list):

```js
// Re-derives everything from scratch — never trusts anything about the request beyond
// the item id and the staff's two choices (disposition, reason).
async function processReturn(itemId, { disposition, reason }) {
  if (disposition !== 'relist' && disposition !== 'remove') {
    throw new Error(`Invalid disposition: ${disposition}`);
  }

  const { rows: itemRows } = await pool.query(
    `SELECT i.id, i.price_current_cents, i.price_original_cents, i.status, i.picked_up_at, i.order_id,
            o.stripe_payment_intent, o.captured_amount_cents, o.refunded_amount_cents, o.credit_donor_id
       FROM items i
       JOIN orders o ON o.id = i.order_id
      WHERE i.id = $1`,
    [itemId]
  );

  if (itemRows.length === 0) {
    throw new Error(`Item ${itemId} not found`);
  }

  const item = itemRows[0];

  if (item.status !== 'picked_up') {
    throw new Error(`Item ${itemId} is not currently picked up (status: ${item.status})`);
  }

  if (!isWithinReturnWindow(item.picked_up_at)) {
    throw new Error('That return window has closed.');
  }

  // Defense in depth alongside the window check above — should be unreachable given it,
  // but this is the same fact jobs/issue-consignment-payouts.js relies on, so it's cheap
  // and correct to double-check here too.
  const { rows: existingPayout } = await pool.query(
    `SELECT 1 FROM store_credit_ledger WHERE item_id = $1 AND reason = 'consignment_payout'`,
    [itemId]
  );
  if (existingPayout.length > 0) {
    throw new Error('That item has already been paid out to its donor and can no longer be returned.');
  }

  const remainingRefundableCents = Math.max(0, item.captured_amount_cents - item.refunded_amount_cents);
  const { cardRefundCents, shortfallCents } = computeReturnSplit(item.price_current_cents, remainingRefundableCents);

  // Real money moves before any database write — matches markOrderPickedUp's ordering
  // (lib/fulfillment.js), so a failed Stripe call never leaves stale local state.
  if (cardRefundCents > 0 && item.stripe_payment_intent) {
    await createRefund(item.stripe_payment_intent, cardRefundCents);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const targetStatus = disposition === 'relist' ? 'active' : 'removed';
    const extraFields = { returned_at: new Date(), return_reason: reason || null };
    if (disposition === 'relist') {
      extraFields.price_current_cents = item.price_original_cents;
      extraFields.listed_at = new Date();
    }

    await transitionItem(client, itemId, 'picked_up', targetStatus, extraFields);

    await client.query(`UPDATE orders SET refunded_amount_cents = refunded_amount_cents + $1 WHERE id = $2`, [
      cardRefundCents,
      item.order_id
    ]);

    if (shortfallCents > 0 && item.credit_donor_id) {
      await client.query(
        `INSERT INTO store_credit_ledger (donor_id, amount_cents, reason, item_id, order_id)
         VALUES ($1, $2, 'return_credit_shortfall', $3, $4)`,
        [item.credit_donor_id, shortfallCents, itemId, item.order_id]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { cardRefundCents, shortfallCents };
}

module.exports = {
  RETURN_WINDOW_DAYS,
  isWithinReturnWindow,
  getReturnEligibleOrders,
  searchOrdersForReturn,
  computeReturnSplit,
  processReturn
};
```

- [ ] **Step 2: Verify syntax**

Run: `node -c lib/returns.js`
Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add lib/returns.js
git commit -m "Add processReturn: refund/credit split, item transition, ledger entry"
```

> **Post-implementation amendment:** two fixes landed on top of this task after code review:
> 1. The `createRefund` call now passes a Stripe idempotency key so a double-click or race can't issue two real refunds for the same return: `await createRefund(item.stripe_payment_intent, cardRefundCents, \`return_${itemId}_${item.order_id}\`)`. It's scoped to `${itemId}_${item.order_id}` (not just `itemId` alone) because an item can be relisted and resold after a return — scoping to the order makes the key unique per purchase-return episode permanently, not just within Stripe's 24-hour idempotency window.
> 2. The `catch` block now logs loudly (matching `markOrderPickedUp`'s precedent in `lib/fulfillment.js`) if a refund already succeeded but the database transaction then failed:
> ```js
>   } catch (err) {
>     await client.query('ROLLBACK');
>     if (cardRefundCents > 0) {
>       // The refund was already actually issued above — losing that fact here would be a
>       // real accounting problem, not just a UI hiccup, so this is deliberately loud.
>       console.error(
>         `processReturn: refunded $${(cardRefundCents / 100).toFixed(2)} to the customer for item ${itemId}, but the database transaction failed afterward — needs manual reconciliation: ${err.message}`
>       );
>     }
>     throw err;
>   } finally {
>     client.release();
>   }
> ```
> Task 6's test below reflects this final shape (mocking `createRefund`'s three-argument signature and asserting the idempotency key it's called with).

---

### Task 6: Real-DB test for `processReturn`

This test needs a live Postgres connection and mocks only the Stripe network call (same pattern `test/purge-photos-idempotency.test.js` uses for `lib/storage`). Per the note at the top of this plan, it is written in full here but not run automatically — it's for manual verification whenever a real `DATABASE_URL` is available.

**Files:**
- Create: `test/process-return.test.js`

- [ ] **Step 1: Write the test**

Create `test/process-return.test.js`:

```js
// test/process-return.test.js
// Proves lib/returns.js's processReturn: the card/credit split is correct (including the
// case where store credit was applied to the order), the item transitions correctly for
// both dispositions, a closed return window is rejected, and a second return attempt on
// the same item is rejected. Requires a live DATABASE_URL — mocks only the Stripe network
// call (lib/stripe.js's createRefund), the same way test/purge-photos-idempotency.test.js
// mocks lib/storage's deletePhoto.
//
// Run with: node test/process-return.test.js
require('dotenv').config();
const assert = require('assert');
const pool = require('../db/pool');

const stripeLib = require('../lib/stripe');
const refundCalls = [];
// Patched before requiring lib/returns.js so its destructured createRefund binding picks
// up this mock instead of a real Stripe call.
stripeLib.createRefund = async (paymentIntentId, amountCents, idempotencyKey) => {
  refundCalls.push({ paymentIntentId, amountCents, idempotencyKey });
  return { id: 're_fake', amount: amountCents };
};

const { processReturn } = require('../lib/returns');
const { getBalanceCents } = require('../lib/store-credit');

const TEST_BIN_NUMBER = 999997;
const TEST_DONOR_PHONE = '5555550299';

async function insertItem({ orderId, priceCurrentCents, priceOriginalCents, pickedUpAt }) {
  const { rows } = await pool.query(
    `INSERT INTO items (bin_number, order_id, title, category, status, price_original_cents, price_current_cents, listed_at, picked_up_at)
     VALUES ($1, $2, 'Return test item', 'other', 'picked_up', $3, $4, NOW(), $5)
     RETURNING id`,
    [TEST_BIN_NUMBER, orderId, priceOriginalCents, priceCurrentCents, pickedUpAt]
  );
  return rows[0].id;
}

async function insertOrder({ subtotalCents, capturedAmountCents, creditDonorId = null, creditAppliedCents = 0 }) {
  const { rows } = await pool.query(
    `INSERT INTO orders (order_number, subtotal_cents, status, stripe_payment_intent, captured_amount_cents, credit_donor_id, credit_applied_cents)
     VALUES ($1, $2, 'completed', $3, $4, $5, $6)
     RETURNING id`,
    [
      `TEST-RETURN-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      subtotalCents,
      `pi_test_fake_${Date.now()}`,
      capturedAmountCents,
      creditDonorId,
      creditAppliedCents
    ]
  );
  return rows[0].id;
}

async function cleanupOrder(orderId) {
  await pool.query('DELETE FROM store_credit_ledger WHERE order_id = $1', [orderId]);
  await pool.query('DELETE FROM price_history WHERE item_id IN (SELECT id FROM items WHERE order_id = $1)', [
    orderId
  ]);
  await pool.query('DELETE FROM items WHERE order_id = $1', [orderId]);
  await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
}

async function run() {
  await pool.query(`INSERT INTO bins (bin_number) VALUES ($1) ON CONFLICT (bin_number) DO NOTHING`, [
    TEST_BIN_NUMBER
  ]);

  // --- Scenario A: plain card order, no credit applied, relisted. ---
  const orderA = await insertOrder({ subtotalCents: 2000, capturedAmountCents: 2000 });
  const itemA = await insertItem({
    orderId: orderA,
    priceCurrentCents: 2000,
    priceOriginalCents: 2500,
    pickedUpAt: new Date()
  });

  const resultA = await processReturn(itemA, { disposition: 'relist', reason: 'Changed mind' });
  assert.deepStrictEqual(resultA, { cardRefundCents: 2000, shortfallCents: 0 }, 'Scenario A: full card refund, no shortfall');
  assert.strictEqual(refundCalls.length, 1, 'Scenario A: exactly one Stripe refund call');
  assert.strictEqual(refundCalls[0].amountCents, 2000, 'Scenario A: refund amount matches item price');
  assert.strictEqual(
    refundCalls[0].idempotencyKey,
    `return_${itemA}_${orderA}`,
    'Scenario A: idempotency key is scoped to this item AND this order'
  );

  const { rows: itemARows } = await pool.query(
    'SELECT status, price_current_cents, returned_at, return_reason FROM items WHERE id = $1',
    [itemA]
  );
  assert.strictEqual(itemARows[0].status, 'active', 'Scenario A: relisted item is active again');
  assert.strictEqual(itemARows[0].price_current_cents, 2500, 'Scenario A: price reset to original on relist');
  assert.ok(itemARows[0].returned_at, 'Scenario A: returned_at stamped');
  assert.strictEqual(itemARows[0].return_reason, 'Changed mind', 'Scenario A: reason recorded');

  const { rows: orderARows } = await pool.query('SELECT refunded_amount_cents FROM orders WHERE id = $1', [orderA]);
  assert.strictEqual(orderARows[0].refunded_amount_cents, 2000, 'Scenario A: order refunded total updated');

  // A second return attempt on the same item must be rejected — it's no longer picked_up.
  await assert.rejects(
    () => processReturn(itemA, { disposition: 'remove', reason: null }),
    /not currently picked up/,
    'Scenario A: a second return attempt is rejected'
  );

  // --- Scenario B: credit applied to the order, item removed (not relisted). ---
  const { rows: donorRows } = await pool.query(
    `INSERT INTO donors (phone_number) VALUES ($1)
     ON CONFLICT (phone_number) DO UPDATE SET phone_number = EXCLUDED.phone_number
     RETURNING id`,
    [TEST_DONOR_PHONE]
  );
  const creditDonorId = donorRows[0].id;
  const balanceBeforeB = await getBalanceCents(pool, creditDonorId);

  // subtotal 3000, credit applied 1000 -> captured 2000. The returned item costs 2500,
  // more than the 2000 still refundable, so this exercises the credit-shortfall path.
  const orderB = await insertOrder({
    subtotalCents: 3000,
    capturedAmountCents: 2000,
    creditDonorId,
    creditAppliedCents: 1000
  });
  const itemB = await insertItem({
    orderId: orderB,
    priceCurrentCents: 2500,
    priceOriginalCents: 3000,
    pickedUpAt: new Date()
  });

  const resultB = await processReturn(itemB, { disposition: 'remove', reason: null });
  assert.deepStrictEqual(
    resultB,
    { cardRefundCents: 2000, shortfallCents: 500 },
    'Scenario B: card refund capped at what remains, rest is shortfall'
  );

  const { rows: itemBRows } = await pool.query('SELECT status, returned_at FROM items WHERE id = $1', [itemB]);
  assert.strictEqual(itemBRows[0].status, 'removed', 'Scenario B: removed item is removed');
  assert.ok(itemBRows[0].returned_at, 'Scenario B: returned_at stamped');

  const balanceAfterB = await getBalanceCents(pool, creditDonorId);
  assert.strictEqual(balanceAfterB, balanceBeforeB + 500, 'Scenario B: shortfall credited to the customer\'s own balance');

  const { rows: ledgerRows } = await pool.query(
    `SELECT amount_cents, reason FROM store_credit_ledger WHERE item_id = $1`,
    [itemB]
  );
  assert.strictEqual(ledgerRows.length, 1, 'Scenario B: exactly one ledger row for the shortfall');
  assert.strictEqual(ledgerRows[0].reason, 'return_credit_shortfall', 'Scenario B: ledger row reason is correct');
  assert.strictEqual(ledgerRows[0].amount_cents, 500, 'Scenario B: ledger row amount matches the shortfall');

  // --- Scenario C: return window already closed. ---
  const orderC = await insertOrder({ subtotalCents: 1500, capturedAmountCents: 1500 });
  const itemC = await insertItem({
    orderId: orderC,
    priceCurrentCents: 1500,
    priceOriginalCents: 1500,
    pickedUpAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000)
  });

  await assert.rejects(
    () => processReturn(itemC, { disposition: 'relist', reason: null }),
    /return window has closed/,
    'Scenario C: a return past the window is rejected'
  );
  const { rows: itemCRows } = await pool.query('SELECT status FROM items WHERE id = $1', [itemC]);
  assert.strictEqual(itemCRows[0].status, 'picked_up', 'Scenario C: rejected return leaves the item untouched');

  await cleanupOrder(orderA);
  await cleanupOrder(orderB);
  await cleanupOrder(orderC);
  await pool.query('DELETE FROM donors WHERE id = $1', [creditDonorId]);
  await pool.query('DELETE FROM bins WHERE bin_number = $1', [TEST_BIN_NUMBER]);

  console.log('PASS: processReturn handles plain-card, credit-shortfall, and closed-window cases correctly.');
}

run()
  .then(() => pool.end())
  .catch((err) => {
    console.error('FAIL:', err.message);
    return pool.end().finally(() => process.exit(1));
  });
```

- [ ] **Step 2: Verify syntax**

Run: `node -c test/process-return.test.js`
Expected: no output (success).

This test is not run against a live database as part of this plan — see the note at the top of this document.

- [ ] **Step 3: Commit**

```bash
git add test/process-return.test.js
git commit -m "Add real-DB test for processReturn (manual-run, requires DATABASE_URL)"
```

---

### Task 7: Wire up the routes

**Files:**
- Modify: `routes/staff.js`

- [ ] **Step 1: Add the import**

`routes/staff.js` currently starts with:

```js
const express = require('express');
const { requireStaffAuth } = require('../middleware/auth');
const { getFulfillmentQueue, markItemPulled, declineItem, markOrderPickedUp } = require('../lib/fulfillment');
const { formatSlotTime } = require('../lib/pickup-schedule');
```

Change it to:

```js
const express = require('express');
const { requireStaffAuth } = require('../middleware/auth');
const { getFulfillmentQueue, markItemPulled, declineItem, markOrderPickedUp } = require('../lib/fulfillment');
const { formatSlotTime } = require('../lib/pickup-schedule');
const { getReturnEligibleOrders, searchOrdersForReturn, processReturn } = require('../lib/returns');
```

- [ ] **Step 2: Add the two new routes**

`routes/staff.js` currently ends with:

```js
router.post(
  '/orders/:id/picked-up',
  asyncHandler(async (req, res) => {
    try {
      await markOrderPickedUp(Number(req.params.id));
      res.redirect('/staff/fulfillment');
    } catch (err) {
      console.error('markOrderPickedUp failed:', err.message);
      res.redirect(`/staff/fulfillment?error=${encodeURIComponent(err.message)}`);
    }
  })
);

module.exports = router;
```

Change it to:

```js
router.post(
  '/orders/:id/picked-up',
  asyncHandler(async (req, res) => {
    try {
      await markOrderPickedUp(Number(req.params.id));
      res.redirect('/staff/fulfillment');
    } catch (err) {
      console.error('markOrderPickedUp failed:', err.message);
      res.redirect(`/staff/fulfillment?error=${encodeURIComponent(err.message)}`);
    }
  })
);

router.get(
  '/returns',
  asyncHandler(async (req, res) => {
    const query = (req.query.q || '').trim();
    const orders = query ? await searchOrdersForReturn(query) : await getReturnEligibleOrders();
    res.render('staff/returns', {
      orders,
      query,
      searched: Boolean(query),
      error: req.query.error || null
    });
  })
);

router.post(
  '/items/:id/return',
  asyncHandler(async (req, res) => {
    const disposition = req.body.disposition;
    const reason = (req.body.reason || '').trim() || null;
    try {
      await processReturn(Number(req.params.id), { disposition, reason });
      res.redirect('/staff/returns');
    } catch (err) {
      console.error('processReturn failed:', err.message);
      res.redirect(`/staff/returns?error=${encodeURIComponent(err.message)}`);
    }
  })
);

module.exports = router;
```

- [ ] **Step 3: Verify syntax**

Run: `node -c routes/staff.js`
Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add routes/staff.js
git commit -m "Add GET /staff/returns and POST /staff/items/:id/return routes"
```

---

### Task 8: The Returns page, nav link, and CSS

**Files:**
- Create: `views/staff/returns.ejs`
- Modify: `views/partials/admin-header.ejs`
- Modify: `public/styles.css`

- [ ] **Step 1: Create the view**

Create `views/staff/returns.ejs`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Returns</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <%- include('../partials/admin-header', { active: 'returns' }) %>

  <main class="staff-page">
    <h1>Returns</h1>

    <% if (error) { %>
      <p class="error"><%= error %></p>
    <% } %>

    <form method="GET" action="/staff/returns" class="bin-create-form">
      <label>
        Search by phone or order number
        <input type="text" name="q" value="<%= query || '' %>" placeholder="(555) 123-4567 or TS-1042">
      </label>
      <button type="submit" class="secondary-btn">Search</button>
    </form>

    <% if (!searched) { %>
      <p class="admin-hint">Showing pickups from the last 7 days.</p>
    <% } %>

    <% if (orders.length === 0) { %>
      <p class="empty-state">
        <%= searched ? 'No matching order found.' : 'No pickups within the return window.' %>
      </p>
    <% } %>

    <% orders.forEach((order) => { %>
      <section class="order-card">
        <div class="order-card-header">
          <strong class="order-number"><%= order.orderNumber %></strong>
          <span class="order-customer">
            <%= order.customerName %><% if (order.customerPhone) { %> &middot; <%= order.customerPhone %><% } %>
          </span>
        </div>

        <% order.items.forEach((item) => { %>
          <div class="fulfillment-item">
            <div class="fulfillment-item-photo">
              <% if (item.photoUrl) { %>
                <img src="<%= item.photoUrl %>" alt="<%= item.title %>">
              <% } else { %>
                <div class="no-photo">No photo</div>
              <% } %>
            </div>
            <div class="fulfillment-item-info">
              <p class="fulfillment-item-title"><%= item.title %></p>
              <p class="fulfillment-item-bin">Bin #<%= item.binNumber %></p>
            </div>
          </div>

          <% if (item.eligible) { %>
            <form method="POST" action="/staff/items/<%= item.id %>/return" class="return-form">
              <input type="text" name="reason" class="return-reason-input" placeholder="Reason (optional)">
              <button type="submit" name="disposition" value="relist" class="pull-btn">Return &amp; Relist</button>
              <button type="submit" name="disposition" value="remove" class="decline-btn">Return &amp; Remove</button>
            </form>
          <% } else { %>
            <p class="admin-hint">
              Not eligible for return
              (<%= item.status === 'picked_up' ? 'return window closed' : item.status %>).
            </p>
          <% } %>
        <% }) %>
      </section>
    <% }) %>
  </main>
</body>
</html>
```

- [ ] **Step 2: Add the nav link**

In `views/partials/admin-header.ejs`, the nav currently reads:

```html
      <a href="/admin/intake" class="<%= active === 'intake' ? 'active' : '' %>">Intake</a>
      <a href="/staff/fulfillment" class="<%= active === 'fulfillment' ? 'active' : '' %>">Fulfillment</a>
      <a href="/admin/donations" class="<%= active === 'donations' ? 'active' : '' %>">Donors</a>
```

Change it to:

```html
      <a href="/admin/intake" class="<%= active === 'intake' ? 'active' : '' %>">Intake</a>
      <a href="/staff/fulfillment" class="<%= active === 'fulfillment' ? 'active' : '' %>">Fulfillment</a>
      <a href="/staff/returns" class="<%= active === 'returns' ? 'active' : '' %>">Returns</a>
      <a href="/admin/donations" class="<%= active === 'donations' ? 'active' : '' %>">Donors</a>
```

- [ ] **Step 3: Add CSS for the return form**

At the end of `public/styles.css`, add:

```css
.return-form {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.6rem;
  padding: 0.5rem 0 0.7rem;
}

.return-reason-input {
  flex: 1 1 160px;
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--shop-border);
  border-radius: 8px;
  font-family: inherit;
  font-size: 0.85rem;
}
```

- [ ] **Step 4: Verify syntax**

Run: `node -c routes/staff.js` (already done in Task 7 — this step just confirms nothing else in this task touched a `.js` file, so there's nothing further to syntax-check here).

- [ ] **Step 5: Commit**

```bash
git add views/staff/returns.ejs views/partials/admin-header.ejs public/styles.css
git commit -m "Add Returns staff page and nav link"
```

---

### Task 9: Fix the donor history ledger-reason label

`store_credit_ledger` now has a third possible `reason` value (`return_credit_shortfall`), and the donor detail page's label mapping doesn't know about it — today it would mislabel any such row as "Redeemed at checkout," which is wrong and misleading in a real donor's history.

**Files:**
- Modify: `views/admin/donor-detail.ejs:68-76`

- [ ] **Step 1: Fix the mapping**

`views/admin/donor-detail.ejs` currently has:

```html
            <% ledger.forEach((entry) => { %>
              <tr>
                <td><%= entry.created_at.toLocaleDateString() %></td>
                <td><%= entry.reason === 'consignment_payout' ? 'Consignment payout' : 'Redeemed at checkout' %></td>
                <td class="<%= entry.amount_cents >= 0 ? 'ledger-credit' : 'ledger-debit' %>">
                  <%= entry.amount_cents >= 0 ? '+' : '−' %>$<%= (Math.abs(entry.amount_cents) / 100).toFixed(2) %>
                </td>
              </tr>
            <% }) %>
```

Change it to:

```html
            <%
              const ledgerReasonLabels = {
                consignment_payout: 'Consignment payout',
                redeemed_at_checkout: 'Redeemed at checkout',
                return_credit_shortfall: 'Return credit'
              };
            %>
            <% ledger.forEach((entry) => { %>
              <tr>
                <td><%= entry.created_at.toLocaleDateString() %></td>
                <td><%= ledgerReasonLabels[entry.reason] || entry.reason %></td>
                <td class="<%= entry.amount_cents >= 0 ? 'ledger-credit' : 'ledger-debit' %>">
                  <%= entry.amount_cents >= 0 ? '+' : '−' %>$<%= (Math.abs(entry.amount_cents) / 100).toFixed(2) %>
                </td>
              </tr>
            <% }) %>
```

- [ ] **Step 2: Commit**

```bash
git add views/admin/donor-detail.ejs
git commit -m "Fix donor ledger label mapping to cover return_credit_shortfall"
```

---

### Task 10: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Syntax-check every touched JS file**

Run:
```bash
for f in db/transitions.js lib/stripe.js lib/returns.js routes/staff.js test/return-split.test.js test/process-return.test.js; do node -c "$f" && echo "OK: $f"; done
```
Expected: `OK: <file>` for all six files.

- [ ] **Step 2: Run the automated test suite**

Run: `npm test`
Expected: all PASS lines, including `PASS: computeReturnSplit correctly splits card refund vs. credit shortfall in all three cases.`

- [ ] **Step 3: Check for stray/uncommitted files**

Run: `git status --short`
Expected: empty (everything from this plan has been committed).

- [ ] **Step 4: Browser smoke test**

Following this project's established preview-harness pattern (temporary `.claude/launch.json` + `scripts/_preview-server.js` at the parent workspace root, cleaned up afterward): start the app, log in as staff, visit `/staff/returns`, and confirm the page renders (empty state is fine with no real picked-up orders locally). Confirm `/staff/fulfillment` still renders correctly and the "Returns" nav link appears and highlights correctly on both pages.

- [ ] **Step 5: Deploy note (do not run automatically)**

Once this is pushed, the migration needs to be applied to production:
```bash
railway ssh --service thrift-on -- npm run migrate
```
This is a deploy step, not part of this implementation plan's automated work — only run it after the person driving this explicitly confirms they want to push and migrate, consistent with how every prior migration in this project has been handled.

---

## Self-review notes

- **Spec coverage:** every section of `docs/superpowers/specs/2026-09-05-staff-returns-design.md` maps to a task above — schema (Task 1), the refund/credit split (Tasks 3, 5, 6), `lib/stripe.js` (Task 2), `lib/returns.js`'s three lookup functions (Task 4) and `processReturn` (Task 5), routes and views (Tasks 7, 8), and the donor-history label gap discovered while writing the spec's ledger-reason value (Task 9).
- **Type consistency:** `disposition` is `'relist' | 'remove'` everywhere it appears (view buttons, route, `processReturn`); the ledger reason string `return_credit_shortfall` is identical in `processReturn`, the real-DB test, and the donor-detail label map; `computeReturnSplit`'s return shape (`{ cardRefundCents, shortfallCents }`) is identical in its definition, its test, and every call site.
