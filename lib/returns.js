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
