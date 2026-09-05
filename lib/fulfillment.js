const pool = require('../db/pool');
const { transitionItem, TransitionConflictError } = require('../db/transitions');
const { capturePaymentIntent, cancelPaymentIntent } = require('./stripe');

// Shared by the staff web UI (routes/staff.js) and the Android app's JSON API
// (routes/api.js) — Section 12 explicitly calls for GET /api/fulfillment to return
// "the same data as the staff page", so both read through this one query.
async function getFulfillmentQueue() {
  const { rows } = await pool.query(`
    SELECT o.id AS order_id, o.order_number, o.customer_email, o.customer_name, o.customer_phone,
           o.status AS order_status, o.pickup_date, o.pickup_time, i.id AS item_id, i.title, i.photo_url,
           i.bin_number, i.status AS item_status
      FROM orders o
      JOIN items i ON i.order_id = o.id
     WHERE o.status IN ('paid', 'ready_for_pickup')
       AND i.status IN ('sold_pending_pull', 'pulled')
     ORDER BY o.pickup_date ASC NULLS LAST, o.pickup_time ASC NULLS LAST, o.created_at ASC, i.id ASC
  `);

  const ordersById = new Map();

  for (const row of rows) {
    if (!ordersById.has(row.order_id)) {
      ordersById.set(row.order_id, {
        orderId: row.order_id,
        orderNumber: row.order_number,
        customerEmail: row.customer_email,
        customerName: row.customer_name,
        customerPhone: row.customer_phone,
        orderStatus: row.order_status,
        pickupDate: row.pickup_date,
        pickupTime: row.pickup_time,
        items: []
      });
    }

    ordersById.get(row.order_id).items.push({
      id: row.item_id,
      title: row.title,
      photoUrl: row.photo_url,
      binNumber: row.bin_number,
      status: row.item_status
    });
  }

  return Array.from(ordersById.values());
}

// Staff taps "Pulled" for one item at a time — physical pulls are confirmed by a human,
// never inferred (Section 2). Once every item on the order has been pulled, the order's
// own status is updated to reflect that known fact, which is what puts the "Mark Picked
// Up" button in front of staff.
async function markItemPulled(itemId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const item = await transitionItem(client, itemId, 'sold_pending_pull', 'pulled', {});

    const { rows: remaining } = await client.query(
      `SELECT 1 FROM items WHERE order_id = $1 AND status = 'sold_pending_pull'`,
      [item.order_id]
    );

    if (remaining.length === 0) {
      await client.query(`UPDATE orders SET status = 'ready_for_pickup' WHERE id = $1 AND status = 'paid'`, [
        item.order_id
      ]);
    }

    await client.query('COMMIT');
    return item;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Staff taps "Declined" on an item the customer didn't want after all, once it's already
// been pulled — it goes back on sale exactly like any other release (same status, same
// listed_at, same markdown clock), and is simply excluded from the capture amount when
// the rest of the order is picked up, instead of ever being charged and then refunded.
async function declineItem(itemId) {
  let orderId = null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: beforeRows } = await client.query('SELECT order_id FROM items WHERE id = $1 FOR UPDATE', [
      itemId
    ]);
    if (beforeRows.length === 0) {
      throw new TransitionConflictError(`Item ${itemId} not found`);
    }
    orderId = beforeRows[0].order_id;

    await transitionItem(client, itemId, 'pulled', 'active', { order_id: null });

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Runs after the decline is already committed, outside that transaction — the decline
  // itself is a real, final fact the moment it's saved; whether the now-moot
  // authorization can also be released is a separate best-effort step that must never
  // block or reverse the decline (Section 2: software never re-infers a physical fact).
  if (orderId) {
    await maybeFinalizeFullyDeclinedOrder(orderId);
  }
}

// If every item on an order has now been declined, there's nothing left to capture —
// release the whole authorization rather than leaving it to expire on its own a week
// later. Best-effort: a failure here just means the hold expires naturally instead of
// being released early. It never leaves an item stuck or gets retried into a double
// cancellation, since the order-status guard below only lets this run once.
async function maybeFinalizeFullyDeclinedOrder(orderId) {
  const { rows: remaining } = await pool.query(
    `SELECT 1 FROM items WHERE order_id = $1 AND status IN ('sold_pending_pull', 'pulled')`,
    [orderId]
  );
  if (remaining.length > 0) return;

  const { rows: orderRows } = await pool.query(
    `SELECT stripe_payment_intent FROM orders WHERE id = $1 AND status IN ('paid', 'ready_for_pickup')`,
    [orderId]
  );
  if (orderRows.length === 0) return; // already finalized, or a credit-only order with nothing to release

  const paymentIntentId = orderRows[0].stripe_payment_intent;

  try {
    if (paymentIntentId) {
      await cancelPaymentIntent(paymentIntentId);
    }
    await pool.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status IN ('paid', 'ready_for_pickup')`, [
      orderId
    ]);
  } catch (err) {
    console.error(`maybeFinalizeFullyDeclinedOrder: could not release order ${orderId}:`, err.message);
  }
}

// Staff taps "Mark Picked Up" once for the whole order after every item has been pulled
// (and any declines already handled) — a single atomic action matching how a real pickup
// happens. This is also the moment the customer is actually charged: the card was only
// authorized at checkout (Section: manual capture), so declined items were simply never
// captured instead of being charged and refunded.
async function markOrderPickedUp(orderId) {
  const { rows: pulledItems } = await pool.query(
    `SELECT id, donor_id, price_current_cents FROM items WHERE order_id = $1 AND status = 'pulled'`,
    [orderId]
  );

  if (pulledItems.length === 0) {
    throw new TransitionConflictError(`No pulled items found for order ${orderId} — nothing to pick up`);
  }

  const { rows: orderRows } = await pool.query(
    'SELECT stripe_payment_intent, status, credit_applied_cents FROM orders WHERE id = $1',
    [orderId]
  );
  if (orderRows.length === 0 || orderRows[0].status !== 'ready_for_pickup') {
    throw new TransitionConflictError(
      `Order ${orderId} was not in status 'ready_for_pickup' (already completed, or not ready)`
    );
  }

  const rawItemsValueCents = pulledItems.reduce((sum, item) => sum + (item.price_current_cents || 0), 0);
  // Store credit was applied against the checkout total up front, so Stripe only ever
  // authorized (subtotal - credit) in the first place — the capture can never exceed
  // that ceiling. Treating credit as applied against whichever items end up being kept
  // means this is always <= what was actually authorized, however many items end up
  // declined.
  const captureAmountCents = Math.max(0, rawItemsValueCents - orderRows[0].credit_applied_cents);
  const paymentIntentId = orderRows[0].stripe_payment_intent;

  // The real charge happens here — deliberately outside any DB transaction, and before
  // any DB write below, so a declined card never leaves the order looking picked up.
  // Stripe doesn't accept a zero-amount capture, so a fully credit-covered remainder
  // (possible if declines left less value than the credit already applied) releases the
  // hold instead — there's nothing left to actually charge the card for.
  if (paymentIntentId) {
    try {
      if (captureAmountCents > 0) {
        await capturePaymentIntent(paymentIntentId, captureAmountCents);
      } else {
        await cancelPaymentIntent(paymentIntentId);
      }
    } catch (err) {
      throw new Error(`Could not charge the customer's card: ${err.message}`);
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The conditional UPDATE is the atomic guard: a double-tap or a stale page can only
    // ever complete the order once. (If this loses the race after the capture above
    // already succeeded, that capture is a real, harmless no-op from Stripe's side —
    // Stripe itself refuses to double-capture an already-captured PaymentIntent.)
    const { rows: completedOrderRows } = await client.query(
      `UPDATE orders
          SET status = 'completed', completed_at = NOW(), captured_at = NOW(), captured_amount_cents = $2
        WHERE id = $1 AND status = 'ready_for_pickup'
        RETURNING *`,
      [orderId, captureAmountCents]
    );

    if (completedOrderRows.length === 0) {
      throw new TransitionConflictError(
        `Order ${orderId} was not in status 'ready_for_pickup' (already completed, or not ready)`
      );
    }

    for (const item of pulledItems) {
      // The consignment payout is NOT issued here — it's deferred until the donor's
      // 7-day return window has fully elapsed (jobs/issue-consignment-payouts.js), so a
      // returned item never has to claw back credit already paid out.
      await transitionItem(client, item.id, 'pulled', 'picked_up', { picked_up_at: new Date() });
    }

    await client.query('COMMIT');
    return completedOrderRows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    if (paymentIntentId) {
      // The card was already actually charged above — losing that fact here would be a
      // real accounting problem, not just a UI hiccup, so this is deliberately loud.
      console.error(
        `markOrderPickedUp: payment intent ${paymentIntentId} was captured for order ${orderId} but the DB commit failed — needs manual reconciliation:`,
        err.message
      );
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getFulfillmentQueue, markItemPulled, declineItem, markOrderPickedUp };
