const Stripe = require('stripe');

let stripeClient = null;

function getClient() {
  if (!stripeClient) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

// price_data is always built from the item's current price_current_cents in our DB,
// never trusted from the browser (Section 9) — the client can't influence what gets charged.
async function createCheckoutSession({ orderId, items, creditCentsToApply = 0 }) {
  const lineItems = items.map((item) => ({
    price_data: {
      currency: 'usd',
      product_data: { name: item.title || `Item #${item.id}` },
      unit_amount: item.price_current_cents
    },
    // Always 1 — every item is one-of-a-kind. This is Stripe's required line-item field,
    // not the restockable-SKU "quantity" concept that's banned from this app (Section 2).
    quantity: 1
  }));

  const sessionParams = {
    mode: 'payment',
    line_items: lineItems,
    // Authorize and hold the funds now, but don't actually take the money until a human
    // confirms the customer picked up (and which items) — see lib/fulfillment.js's
    // markOrderPickedUp. Avoids ever charging for an item the customer declines at the
    // counter and then having to refund it. Note: card issuers release an uncaptured
    // authorization after about 7 days, which is why pickup-date selection at checkout
    // (routes/storefront.js) caps how far out a customer can choose.
    payment_intent_data: { capture_method: 'manual' },
    // No customer_email to prefill — checkout collects a name/phone instead, not email.
    // Stripe's own hosted page still asks for an email itself (that's Stripe's own
    // receipt requirement for `mode: 'payment'`, not something this param controls); the
    // customer just enters it there instead of on our page.
    success_url: `${process.env.BASE_URL}/order/success?order=${orderId}`,
    cancel_url: `${process.env.BASE_URL}/order/cancelled?order=${orderId}`,
    // The order id lets the webhook find the order; item_ids lets it know exactly which
    // items to transition to sold_pending_pull once payment is confirmed (Section 9).
    metadata: {
      order_id: String(orderId),
      item_ids: items.map((item) => item.id).join(',')
    }
  };

  if (creditCentsToApply > 0) {
    // A one-time dynamic discount for exactly the credit being applied — simpler than
    // trying to shrink individual line-item prices to add up to the right remainder.
    const coupon = await getClient().coupons.create({
      amount_off: creditCentsToApply,
      currency: 'usd',
      duration: 'once',
      name: `Store credit applied to order ${orderId}`
    });
    sessionParams.discounts = [{ coupon: coupon.id }];
  }

  return getClient().checkout.sessions.create(sessionParams);
}

// Takes the money for real, for exactly the amount the customer is actually taking home —
// which can be less than the original authorization if they declined some items at the
// counter (lib/fulfillment.js's markOrderPickedUp computes amountCents from whichever
// items are still 'pulled', i.e. not individually declined).
async function capturePaymentIntent(paymentIntentId, amountCents) {
  return getClient().paymentIntents.capture(paymentIntentId, { amount_to_capture: amountCents });
}

// Releases the entire held authorization without ever charging anything — used when a
// customer ends up declining every item on an order, so there's nothing left to capture.
async function cancelPaymentIntent(paymentIntentId) {
  return getClient().paymentIntents.cancel(paymentIntentId);
}

// A partial refund against an already-captured PaymentIntent — used by lib/returns.js for
// the card portion of a processed return. Stripe rejects a request for more than what's
// actually still capturable/refunded, so the caller (computeReturnSplit) is responsible
// for never asking for more than what's left.
// Unlike paymentIntents.capture, refunds.create has no natural protection against being
// called twice for the same thing — so an optional idempotencyKey lets a caller make a
// repeat call (e.g. a double form submission) a safe no-op on Stripe's side instead of a
// second real refund.
async function createRefund(paymentIntentId, amountCents, idempotencyKey) {
  return getClient().refunds.create(
    { payment_intent: paymentIntentId, amount: amountCents },
    idempotencyKey ? { idempotencyKey } : undefined
  );
}

module.exports = {
  getClient,
  createCheckoutSession,
  capturePaymentIntent,
  cancelPaymentIntent,
  createRefund
};
