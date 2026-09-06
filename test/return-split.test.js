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
