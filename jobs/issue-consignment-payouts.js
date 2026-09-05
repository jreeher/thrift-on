const pool = require('../db/pool');
const { issuePayout } = require('../lib/store-credit');

// Items are eligible for return for 7 days after pickup — the payout is deliberately
// withheld until that window has fully elapsed, so a returned item never requires
// clawing back credit already paid to the donor.
const RETURN_WINDOW_DAYS = 7;

// Runs daily. Must be idempotent: the NOT EXISTS guard against an existing
// consignment_payout ledger row for the item means an item is only ever paid out once —
// re-running finds nothing left to pay and does nothing.
async function issueConsignmentPayouts() {
  const { rows: candidates } = await pool.query(
    `SELECT id, donor_id, price_current_cents
       FROM items
      WHERE status = 'picked_up'
        AND donor_id IS NOT NULL
        AND picked_up_at < NOW() - ($1 * INTERVAL '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM store_credit_ledger sc
           WHERE sc.item_id = items.id AND sc.reason = 'consignment_payout'
        )`,
    [RETURN_WINDOW_DAYS + 1]
  );

  let issuedCount = 0;

  for (const item of candidates) {
    try {
      await issuePayout(pool, item);
      issuedCount += 1;
    } catch (err) {
      console.error(`issueConsignmentPayouts: failed to pay out item ${item.id}:`, err.message);
    }
  }

  console.log(`issueConsignmentPayouts: issued ${issuedCount} payout(s)`);
  return issuedCount;
}

module.exports = { issueConsignmentPayouts, RETURN_WINDOW_DAYS };
