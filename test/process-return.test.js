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
