// test/consignment-payout.test.js
// Proves the payout timing split: marking an order picked up no longer issues credit
// immediately — issueConsignmentPayouts only pays out an item once its 7-day return
// window has fully elapsed (8 days past picked_up_at), and never twice. Requires a live
// DATABASE_URL — this exercises markOrderPickedUp's and issueConsignmentPayouts' real
// SQL against a real Postgres instance, the same way test/cart-concurrency.test.js does.
//
// Run with: node test/consignment-payout.test.js
require('dotenv').config();
const assert = require('assert');
const pool = require('../db/pool');
const { markOrderPickedUp } = require('../lib/fulfillment');
const { getBalanceCents } = require('../lib/store-credit');
const { issueConsignmentPayouts } = require('../jobs/issue-consignment-payouts');

const TEST_BIN_NUMBER = 999998;
const TEST_PHONE = '5555550199';

async function setup() {
  await pool.query(`INSERT INTO bins (bin_number) VALUES ($1) ON CONFLICT (bin_number) DO NOTHING`, [
    TEST_BIN_NUMBER
  ]);

  const { rows: donorRows } = await pool.query(
    `INSERT INTO donors (phone_number) VALUES ($1)
     ON CONFLICT (phone_number) DO UPDATE SET phone_number = EXCLUDED.phone_number
     RETURNING id`,
    [TEST_PHONE]
  );
  const donorId = donorRows[0].id;

  const { rows: orderRows } = await pool.query(
    `INSERT INTO orders (order_number, customer_email, subtotal_cents, status)
     VALUES ('TEST-PAYOUT-1', 'test@example.com', 2000, 'ready_for_pickup')
     RETURNING id`
  );
  const orderId = orderRows[0].id;

  const { rows: itemRows } = await pool.query(
    `INSERT INTO items (bin_number, donor_id, order_id, title, category, status, price_original_cents, price_current_cents, listed_at)
     VALUES ($1, $2, $3, 'Payout test item', 'other', 'pulled', 2000, 2000, NOW())
     RETURNING id`,
    [TEST_BIN_NUMBER, donorId, orderId]
  );

  return { donorId, orderId, itemId: itemRows[0].id };
}

async function cleanup({ donorId, orderId, itemId }) {
  await pool.query('DELETE FROM store_credit_ledger WHERE donor_id = $1', [donorId]);
  await pool.query('DELETE FROM price_history WHERE item_id = $1', [itemId]);
  await pool.query('DELETE FROM items WHERE id = $1', [itemId]);
  await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
  await pool.query('DELETE FROM donors WHERE id = $1', [donorId]);
  await pool.query('DELETE FROM bins WHERE bin_number = $1', [TEST_BIN_NUMBER]);
}

async function run() {
  const ctx = await setup();

  await markOrderPickedUp(ctx.orderId);

  const { rows: itemRows } = await pool.query('SELECT picked_up_at FROM items WHERE id = $1', [ctx.itemId]);
  assert.ok(itemRows[0].picked_up_at, 'pickup should stamp picked_up_at');

  const balanceRightAfterPickup = await getBalanceCents(pool, ctx.donorId);
  assert.strictEqual(
    balanceRightAfterPickup,
    0,
    'credit must not be issued at pickup — only after the return window elapses'
  );

  // The order-level guard is unrelated to payout timing, but must still hold.
  await assert.rejects(() => markOrderPickedUp(ctx.orderId), /was not in status 'ready_for_pickup'/);

  // The item is still inside its 7-day return window — the job should find nothing yet.
  const issuedWhileInWindow = await issueConsignmentPayouts();
  assert.strictEqual(issuedWhileInWindow, 0, 'must not pay out before the return window has elapsed');
  assert.strictEqual(await getBalanceCents(pool, ctx.donorId), 0);

  // Backdate picked_up_at to simulate the return window having closed.
  await pool.query(`UPDATE items SET picked_up_at = NOW() - INTERVAL '9 days' WHERE id = $1`, [ctx.itemId]);

  const issuedAfterWindow = await issueConsignmentPayouts();
  assert.strictEqual(issuedAfterWindow, 1, 'should pay out exactly one item once its return window has elapsed');
  const balanceAfterPayout = await getBalanceCents(pool, ctx.donorId);
  assert.strictEqual(
    balanceAfterPayout,
    1000,
    `Expected $10.00 payout (50% of $20.00), got ${balanceAfterPayout} cents`
  );

  // A repeat run must not double-pay.
  const issuedSecondRun = await issueConsignmentPayouts();
  assert.strictEqual(issuedSecondRun, 0, 'repeat job run must not double-pay');
  assert.strictEqual(await getBalanceCents(pool, ctx.donorId), balanceAfterPayout);

  await cleanup(ctx);
  console.log(
    'PASS: pickup no longer issues credit immediately; the payout job issues it exactly once, only after the return window elapses.'
  );
}

run()
  .then(() => pool.end())
  .catch((err) => {
    console.error('FAIL:', err.message);
    return pool.end().finally(() => process.exit(1));
  });
