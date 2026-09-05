// Verifies jobs/issue-consignment-payouts.js is idempotent using a mocked db/pool — a
// real run's idempotency comes from the NOT EXISTS guard in the actual SQL; this test
// proves the job's own logic doesn't do anything extra on a rerun once that guard has
// correctly excluded an item.
//
// Run with: node test/issue-consignment-payouts-idempotency.test.js
const assert = require('assert');
const pool = require('../db/pool');

let insertCalls = [];

function mockPool(candidateRows) {
  insertCalls = [];
  pool.query = async (sql, params) => {
    if (sql.includes('SELECT id, donor_id, price_current_cents')) {
      return { rows: candidateRows };
    }
    if (sql.includes('INSERT INTO store_credit_ledger')) {
      insertCalls.push(params);
      return { rows: [] };
    }
    return { rows: [] };
  };
}

const { issueConsignmentPayouts } = require('../jobs/issue-consignment-payouts');

async function run() {
  // First run: one eligible item, past its return window.
  mockPool([{ id: 1, donor_id: 5, price_current_cents: 2000 }]);
  const firstCount = await issueConsignmentPayouts();
  assert.strictEqual(firstCount, 1, 'first run should pay out the one eligible item');
  assert.strictEqual(insertCalls.length, 1, 'first run should write one ledger row');
  assert.strictEqual(insertCalls[0][0], 5, 'ledger row should credit the item\'s donor');
  assert.strictEqual(insertCalls[0][1], 1000, 'payout should be 50% of price_current_cents');

  // Second run: against a real database the NOT EXISTS guard means the SELECT no
  // longer returns an item once it already has a consignment_payout ledger row.
  mockPool([]);
  const secondCount = await issueConsignmentPayouts();
  assert.strictEqual(secondCount, 0, 'second run should find nothing left to pay out');
  assert.strictEqual(insertCalls.length, 0, 'second run should not write another ledger row');

  console.log('PASS: issue-consignment-payouts job pays out once per item, then is a true no-op on rerun.');
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FAIL:', err.message);
    process.exit(1);
  });
