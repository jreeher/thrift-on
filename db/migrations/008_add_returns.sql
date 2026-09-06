-- returned_at is a permanent record that an item was sold and then returned, independent
-- of whatever status it lands in afterward (active if relisted, removed if not) — without
-- it, relisting would silently erase the fact that this item came back once.
ALTER TABLE items ADD COLUMN returned_at TIMESTAMPTZ;
ALTER TABLE items ADD COLUMN return_reason TEXT;

-- Accumulates as returns are processed against an order, the same role
-- captured_amount_cents already plays for captures — this is what lets the refund math in
-- lib/returns.js stay correct across multiple returns from the same multi-item order.
ALTER TABLE orders ADD COLUMN refunded_amount_cents INTEGER NOT NULL DEFAULT 0;
