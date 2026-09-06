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
    await createRefund(item.stripe_payment_intent, cardRefundCents, `return_${itemId}_${item.order_id}`);
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
    if (cardRefundCents > 0) {
      // The refund was already actually issued above — losing that fact here would be a
      // real accounting problem, not just a UI hiccup, so this is deliberately loud.
      console.error(
        `processReturn: refunded $${(cardRefundCents / 100).toFixed(2)} to the customer for item ${itemId} but the DB commit failed — needs manual reconciliation:`,
        err.message
      );
    }
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
