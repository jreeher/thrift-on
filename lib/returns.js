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
