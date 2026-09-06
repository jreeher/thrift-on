// Thrown only for the expected "someone else already changed this" race — distinct from
// a plain Error (bad transition, DB down) so callers can safely map just this case to a
// 409 without accidentally masking real infrastructure failures as business conflicts.
class TransitionConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransitionConflictError';
  }
}

const VALID_TRANSITIONS = [
  ['draft', 'active'],
  ['active', 'reserved'],
  ['reserved', 'active'],
  ['reserved', 'sold_pending_pull'],
  ['sold_pending_pull', 'pulled'],
  ['pulled', 'picked_up'],
  ['pulled', 'active'],
  ['active', 'expired'],
  ['picked_up', 'active']
];

function isValidTransition(fromStatus, toStatus) {
  if (toStatus === 'removed') return true; // any -> removed
  return VALID_TRANSITIONS.some(([from, to]) => from === fromStatus && to === toStatus);
}

// An item must never be sold twice, and no status change should ever be inferred instead
// of confirmed (Section 2). Every lifecycle transition goes through this single helper so
// the WHERE status = fromStatus conditional update is the only way status ever changes —
// a concurrent transition that already moved the row makes this a no-op that throws,
// never a double-apply.
async function transitionItem(client, itemId, fromStatus, toStatus, extraFields = {}) {
  if (!isValidTransition(fromStatus, toStatus)) {
    throw new Error(`Invalid item transition: ${fromStatus} -> ${toStatus}`);
  }

  const setClauses = ['status = $1', 'updated_at = NOW()'];
  const values = [toStatus];
  let paramIndex = 2;

  for (const [field, value] of Object.entries(extraFields)) {
    setClauses.push(`${field} = $${paramIndex}`);
    values.push(value);
    paramIndex += 1;
  }

  const itemIdParam = paramIndex;
  const fromStatusParam = paramIndex + 1;
  values.push(itemId, fromStatus);

  const { rows } = await client.query(
    `UPDATE items
        SET ${setClauses.join(', ')}
      WHERE id = $${itemIdParam} AND status = $${fromStatusParam}
      RETURNING *`,
    values
  );

  if (rows.length === 0) {
    throw new TransitionConflictError(
      `item ${itemId} was not in status '${fromStatus}' (already transitioned, or does not exist)`
    );
  }

  return rows[0];
}

module.exports = { transitionItem, isValidTransition, TransitionConflictError };
