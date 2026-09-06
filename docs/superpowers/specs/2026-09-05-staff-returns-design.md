# Staff-processed returns — design

## Context

This is the follow-on spec flagged as out-of-scope in `2026-08-14-store-credit-design.md` ("refunds-as-credit for declined-at-pickup and post-pickup returns... gets its own spec later"), and it's also the direct motivation for the deferred-payout change made just before this spec: `jobs/issue-consignment-payouts.js` now withholds a donor's consignment payout until 8 days after `items.picked_up_at` (a 7-day return window, plus the day it closes), specifically so a returned item never requires clawing back credit already paid to the donor. That change created a hole this spec fills: there was no way to actually record that a customer returned an item.

## Goals

- Give staff a way to process a return for any item that's been picked up within the last 7 days.
- Refund the customer correctly, including the case where store credit (not just a card) paid for part of the original order.
- Guarantee a returned item's donor never receives (or keeps) a consignment payout for it.
- Let staff choose, per return, whether the item goes back on the floor or is removed from inventory.

## Non-goals

- Any return older than 7 days past pickup — blocked outright, no staff override. If an exception is ever needed, it's a manual/out-of-app fix, not a feature.
- Automatically clawing back a donor's payout if a return somehow happens after the payout already went out — precluded by the 7-day hard block above, so it should never arise.
- A customer-facing return request flow — this is staff-initiated only, at the counter.
- Partial-item returns (e.g. "half of this item") — a return is always whole-item.

## Schema

New migration (`008_add_returns.sql`):

```sql
ALTER TABLE items ADD COLUMN returned_at TIMESTAMPTZ;
ALTER TABLE items ADD COLUMN return_reason TEXT;
ALTER TABLE orders ADD COLUMN refunded_amount_cents INTEGER NOT NULL DEFAULT 0;
```

`returned_at` is a permanent record that an item was sold and then returned, independent of whatever status it lands in afterward (`active` if relisted, `removed` if not) — without it, relisting would silently erase the fact that this item came back once. `return_reason` is an optional free-text note staff can enter (e.g. "didn't fit," "changed mind") for later reference. `orders.refunded_amount_cents` accumulates as returns are processed against an order, the same role `captured_amount_cents` already plays for captures — it's what lets the refund math below stay correct across multiple returns from the same multi-item order.

`db/transitions.js` also gains one new entry in `VALID_TRANSITIONS`: `['picked_up', 'active']` (the relist path). `picked_up → removed` already works today via the existing "anything can go to removed" rule, so no change needed there.

## The refund/credit split

Every order already tracks `captured_amount_cents` (what Stripe actually captured at pickup — which is less than the raw item total whenever store credit was applied). For a single item's return:

```
remaining  = orders.captured_amount_cents - orders.refunded_amount_cents
cardRefund = min(item.price_current_cents, remaining)
shortfall  = item.price_current_cents - cardRefund
```

`cardRefund` is issued as a partial Stripe refund against the order's `stripe_payment_intent`. `shortfall` — the part of this item's price that the remaining captured amount can't cover — is credited back to the customer's own store-credit balance via `orders.credit_donor_id`, but only if that column is set (i.e., credit was actually applied to this order).

This one formula handles every case without special-casing:
- **All-card order, no credit applied:** `captured_amount_cents` equals the full item total, so `remaining` is always enough to cover any single item in full. `shortfall` is always 0 — nothing ever gets credited, only refunded.
- **Order with partial credit applied:** as returns are processed one at a time, each draws down `remaining` first; once it's exhausted, later returns' shortfalls flow to credit instead. Whichever order returns happen to be processed in, the totals across the whole order always add up to exactly the original subtotal split between card and credit — never more, never less.
- **Order fully covered by credit** (`completeOrderFullyWithCredit` path — no Stripe session ever created, `captured_amount_cents` is 0, `stripe_payment_intent` is null): `remaining` is 0 for every return, so `cardRefund` is always 0 and the entire item price flows to credit. Exactly right, with no extra branch needed.

The pure card/shortfall math is factored into its own function, `computeReturnSplit(itemPriceCents, remainingRefundableCents)`, so it can be unit-tested without a database.

## `lib/returns.js` (new)

- `getReturnEligibleOrders()` — orders with at least one item `status = 'picked_up'` and `picked_up_at` within the last 7 days. Same query shape as `getFulfillmentQueue`.
- `searchOrdersForReturn(query)` — matches an order number or a phone number (digits only), any age. This is a lookup only — it doesn't filter by eligibility, so staff can always find and see an order even if nothing on it is actionable anymore. Eligibility is enforced only at the point of actually processing a return (see below).
- `computeReturnSplit(itemPriceCents, remainingRefundableCents)` — pure function, see above.
- `processReturn(itemId, { disposition, reason })` — `disposition` is `'relist'` or `'remove'`. Re-derives everything from scratch, never trusts anything about the request beyond the item id and the staff's two choices:
  1. Load the item and its order. Reject if the item's status isn't `picked_up`.
  2. Reject if `picked_up_at` is more than 7 days ago ("That return window has closed.").
  3. Reject if a `consignment_payout` ledger row already exists for this item (defense in depth alongside #2 — should be unreachable given #2, but cheap to check).
  4. Compute `cardRefund`/`shortfall` per the formula above.
  5. If `cardRefund > 0`, call Stripe to refund it (via a new `createRefund` in `lib/stripe.js`) — **before any database write**, matching how `markOrderPickedUp` already orders a real Stripe call ahead of the DB transaction so a failed Stripe call never leaves stale local state.
  6. In one DB transaction: transition the item (`picked_up → active` with `price_current_cents` reset to `price_original_cents` and `listed_at` reset to now, if relisting; `picked_up → removed` otherwise — either way stamping `returned_at = NOW()` and `return_reason`), bump `orders.refunded_amount_cents` by `cardRefund`, and — if `shortfall > 0` and `credit_donor_id` is set — insert a `store_credit_ledger` row (`reason = 'return_credit_shortfall'`, `amount_cents = shortfall`, referencing both `item_id` and `order_id`).

## `lib/stripe.js`

One addition: `createRefund(paymentIntentId, amountCents)`, a thin wrapper around `stripe.refunds.create({ payment_intent, amount })`, matching the style of the existing `capturePaymentIntent`/`cancelPaymentIntent`.

## Routes and views

- `routes/staff.js`: `GET /returns` (renders the search box plus, by default, the recent-pickups list) and `POST /items/:id/return` (body: `disposition`, optional `reason`) — following the existing try/catch-and-redirect-with-`?error=` pattern already used by `/items/:id/pulled`, `/items/:id/decline`, and `/orders/:id/picked-up`.
- `views/staff/returns.ejs` (new): search form at top; below it, each eligible order shown with its items, each item getting a small inline form with a reason field and two submit buttons (**Return & Relist**, **Return & Remove**) that both post to the same `/items/:id/return` route with a different `disposition`.
- `views/partials/admin-header.ejs`: add a "Returns" nav link alongside Fulfillment/Schedule/Reports.

This is a new page rather than a section bolted onto the existing Fulfillment page — Fulfillment's whole mental model is "orders on their way to pickup," and mixing in "orders already picked up, might come back" would blur that.

## Error handling

- Window closed, already returned, or already paid out: `processReturn` throws a clear, specific error; the route catches it and redirects back to `/staff/returns` with `?error=`, same UX as the existing staff actions.
- A failed Stripe refund call surfaces its message the same way and leaves the item/order completely untouched (per the "Stripe call before any DB write" ordering above).

## Testing

Following this codebase's existing convention (tests only for atomicity-sensitive/money-moving paths get automated coverage):

- `computeReturnSplit` gets a fast, no-DB unit test wired into `npm run test` (mirroring `test/issue-consignment-payouts-idempotency.test.js`'s style), covering the three cases above: plain-card, partial-credit, and fully-credit-covered.
- `processReturn` gets a real-DB test (manual-run, mirroring `test/consignment-payout.test.js`): an end-to-end return producing a real (test-mode) Stripe refund, the window-closed rejection, and the double-return rejection.

## Out of scope for now

- `jobs/issue-consignment-payouts.js` needs no change — a returned item leaves `picked_up` status entirely (landing on `active` or `removed`), so its existing `WHERE status = 'picked_up'` guard already excludes it automatically.
- No UI change needed on the donor-facing side or the storefront — this is entirely a staff-facing addition.
