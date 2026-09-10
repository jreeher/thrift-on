const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { requireStaffAuth } = require('../middleware/auth');
const { transitionItem } = require('../db/transitions');
const { ALLOWED_CATEGORIES, clampSuggestedPrice, basePriceForCategory } = require('../lib/pricing');
const { isConsolidationCandidate, ratchetBinPeak } = require('../lib/bins');
const { uploadPhoto } = require('../lib/storage');
const { analyzeItemPhoto } = require('../lib/ai');
const {
  RESULT_LIMIT: REPORT_RESULT_LIMIT,
  ITEM_STATUSES,
  ORDER_STATUSES,
  BIN_STATUSES,
  getItemsReport,
  getOrdersReport,
  getDonorsReport,
  getBinsReport
} = require('../lib/reports');
const { getRecentDonors, findDonorByPhone, getDonorHistory } = require('../lib/donors');
const { ITEM_STATUS_LABELS } = require('../lib/item-status');
const { pickupDateBounds, pickupDateRange, getSlotsForDate, setSlotOpen } = require('../lib/pickup-schedule');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const INTAKE_BIN_COOKIE = 'intake_bin';
const LAST_INTAKE_BIN_COOKIE = 'last_intake_bin';
const INTAKE_DONOR_COOKIE = 'intake_donor';

function intakeCookieOptions(maxAgeMs) {
  return {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: maxAgeMs
  };
}

async function loadCurrentDonor(req) {
  const donorId = req.signedCookies[INTAKE_DONOR_COOKIE];
  if (!donorId) return null;
  const { rows } = await pool.query('SELECT * FROM donors WHERE id = $1', [Number(donorId)]);
  return rows[0] || null;
}

router.use(requireStaffAuth);
router.use(express.urlencoded({ extended: false }));

router.get('/', (req, res) => {
  res.render('admin/home');
});

// draft keeps the existing AI-draft review form; active/reserved get an editable card;
// everything else (mid-transaction or terminal statuses) is read-only, since editing a
// sold/historical item doesn't fit the state machine (Section 6).
function inventoryCardVariant(status) {
  if (status === 'draft') return 'draft';
  if (status === 'active' || status === 'reserved') return 'editable';
  return 'readonly';
}

router.get(
  '/inventory',
  asyncHandler(async (req, res) => {
    const status = ITEM_STATUSES.includes(req.query.status) ? req.query.status : 'draft';
    const { rows: items } = await pool.query(`SELECT * FROM items WHERE status = $1 ORDER BY created_at ASC`, [
      status
    ]);
    res.render('admin/inventory', {
      items,
      status,
      statuses: ITEM_STATUSES,
      statusLabels: ITEM_STATUS_LABELS,
      cardVariant: inventoryCardVariant(status),
      // Only expired items get a Remove button among the read-only statuses — sold/pulled/
      // picked-up items are mid-transaction or historical, and hiding removal there avoids
      // someone accidentally erasing a real sale from the record.
      canRemove: status === 'expired',
      categories: ALLOWED_CATEGORIES
    });
  })
);

// Old bookmarks/links to the review queue land on the same page, on the draft tab.
router.get('/review', (req, res) => {
  res.redirect('/admin/inventory');
});

router.post(
  '/inventory/:id/edit',
  asyncHandler(async (req, res) => {
    const itemId = Number(req.params.id);
    const {
      title,
      category,
      description,
      condition_notes: conditionNotes,
      bin_number: binNumberRaw,
      status: returnStatus
    } = req.body;

    const finalCategory = ALLOWED_CATEGORIES.includes(category) ? category : 'other';
    const binNumber = binNumberRaw ? Number(binNumberRaw) : null;

    // A plain field update, not a lifecycle transition — status doesn't change, so this
    // intentionally doesn't go through transitionItem (which only permits the fixed set of
    // transitions in db/transitions.js). Price isn't editable here: it interacts with the
    // automatic markdown schedule (Section 7), which needs its own design.
    await pool.query(
      `UPDATE items
          SET title = $1, category = $2, description = $3, condition_notes = $4,
              bin_number = $5, human_edited = TRUE, updated_at = NOW()
        WHERE id = $6`,
      [title || null, finalCategory, description || null, conditionNotes || null, binNumber, itemId]
    );

    if (binNumber) {
      await ratchetBinPeak(pool, binNumber);
    }

    res.redirect(`/admin/inventory?status=${encodeURIComponent(returnStatus || 'active')}`);
  })
);

router.post(
  '/inventory/:id/remove',
  asyncHandler(async (req, res) => {
    const itemId = Number(req.params.id);
    const returnStatus = req.body.status || 'active';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT status FROM items WHERE id = $1 FOR UPDATE', [itemId]);
      if (rows.length > 0) {
        // "any -> removed" is always valid (Section 6) — read the row's actual current
        // status rather than trusting the form's snapshot, in case it changed since the
        // page was rendered.
        await transitionItem(client, itemId, rows[0].status, 'removed');
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.redirect(`/admin/inventory?status=${encodeURIComponent(returnStatus)}`);
  })
);

router.post(
  '/review/:id/approve',
  asyncHandler(async (req, res) => {
    const itemId = Number(req.params.id);
    const {
      title,
      category,
      description,
      condition_notes: conditionNotes,
      price_dollars: priceDollarsRaw,
      bin_number: binNumberRaw
    } = req.body;

    const finalCategory = ALLOWED_CATEGORIES.includes(category) ? category : 'other';
    // Staff type a dollar amount (the form is never allowed to show raw cents) — this is
    // the one place that boundary-converts it to the integer cents everything else uses.
    const parsedDollars = Number(priceDollarsRaw);
    const parsedCents = Number.isFinite(parsedDollars) && parsedDollars > 0 ? Math.round(parsedDollars * 100) : NaN;
    const priceCents = clampSuggestedPrice(
      finalCategory,
      Number.isFinite(parsedCents) && parsedCents > 0 ? parsedCents : basePriceForCategory(finalCategory)
    );
    const binNumber = binNumberRaw ? Number(binNumberRaw) : null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // A human must approve every item before it goes live (Section 2) — this route is
      // the only path that moves an item from draft to active.
      const item = await transitionItem(client, itemId, 'draft', 'active', {
        title: title || null,
        category: finalCategory,
        description: description || null,
        condition_notes: conditionNotes || null,
        bin_number: binNumber,
        price_original_cents: priceCents,
        price_current_cents: priceCents,
        listed_at: new Date(),
        human_edited: true
      });

      await client.query(
        `INSERT INTO price_history (item_id, price_cents, reason) VALUES ($1, $2, 'initial')`,
        [item.id, priceCents]
      );

      if (binNumber) {
        await ratchetBinPeak(client, binNumber);
      }

      await client.query('COMMIT');
      // Approving from the intake flow goes back to intake, ready for the next photo —
      // approving from the general Inventory drafts tab stays on Inventory. Both pages
      // render the same review-card form (views/partials/item-review-card.ejs), which
      // stamps this hidden field so the route knows which one to return to.
      const returnTo = req.body.return_to === 'intake' ? '/admin/intake' : '/admin/inventory';
      res.redirect(returnTo);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  })
);

router.get(
  '/intake',
  asyncHandler(async (req, res) => {
    const openBin = req.signedCookies[INTAKE_BIN_COOKIE];
    if (!openBin) {
      return res.render('admin/intake-open', {
        lastBin: req.signedCookies[LAST_INTAKE_BIN_COOKIE] || '',
        error: null
      });
    }
    const donor = await loadCurrentDonor(req);
    res.render('admin/intake-upload', { binNumber: openBin, donor, error: null });
  })
);

router.post(
  '/intake/open',
  asyncHandler(async (req, res) => {
    const binNumber = req.body.bin_number ? Number(req.body.bin_number) : NaN;
    if (!Number.isInteger(binNumber)) {
      return res.render('admin/intake-open', {
        lastBin: req.body.bin_number || '',
        error: 'Bin number must be an integer.'
      });
    }

    // Bins are no longer pre-created on a separate page — any bin number works, and
    // opening it here creates the row on first use (no-op if it already exists).
    await pool.query('INSERT INTO bins (bin_number) VALUES ($1) ON CONFLICT (bin_number) DO NOTHING', [binNumber]);

    res.cookie(INTAKE_BIN_COOKIE, String(binNumber), intakeCookieOptions(12 * 60 * 60 * 1000));
    res.cookie(LAST_INTAKE_BIN_COOKIE, String(binNumber), intakeCookieOptions(30 * 24 * 60 * 60 * 1000));
    res.redirect('/admin/intake');
  })
);

router.post(
  '/intake/close',
  asyncHandler(async (req, res) => {
    const openBin = req.signedCookies[INTAKE_BIN_COOKIE];
    if (openBin) {
      // This is now just a belt-and-suspenders snapshot — every actual bin_number
      // assignment (intake, approval, editing) already ratchets the peak itself, so the
      // bin stays correct even if this button never gets tapped.
      await ratchetBinPeak(pool, Number(openBin));
    }

    res.clearCookie(INTAKE_BIN_COOKIE);
    res.redirect('/admin/intake');
  })
);

router.post(
  '/intake/donor',
  asyncHandler(async (req, res) => {
    const openBin = req.signedCookies[INTAKE_BIN_COOKIE];
    if (!openBin) {
      return res.redirect('/admin/intake');
    }

    // An empty submission is how "Change Donor" clears the current donor back to none.
    const donorIdRaw = (req.body.donor_id || '').trim();
    if (donorIdRaw === '') {
      res.clearCookie(INTAKE_DONOR_COOKIE);
      return res.redirect('/admin/intake');
    }

    const donorId = Number(donorIdRaw);
    if (!Number.isInteger(donorId)) {
      const donor = await loadCurrentDonor(req);
      return res.render('admin/intake-upload', {
        binNumber: openBin,
        donor,
        error: 'Donor ID must be an integer.'
      });
    }

    // Donor ids come from the Donations page, not typed freely like a bin number — a
    // donor row must already exist, so a typo doesn't silently attach items to nobody.
    const { rows } = await pool.query('SELECT id FROM donors WHERE id = $1', [donorId]);
    if (rows.length === 0) {
      const donor = await loadCurrentDonor(req);
      return res.render('admin/intake-upload', {
        binNumber: openBin,
        donor,
        error: `Donor #${donorId} not found — register them on the Donations page first.`
      });
    }

    res.cookie(INTAKE_DONOR_COOKIE, String(donorId), intakeCookieOptions(12 * 60 * 60 * 1000));
    res.redirect('/admin/intake');
  })
);

router.post(
  '/intake',
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    const openBin = req.signedCookies[INTAKE_BIN_COOKIE];
    if (!openBin) {
      return res.redirect('/admin/intake');
    }
    const binNumber = Number(openBin);
    const donorIdCookie = req.signedCookies[INTAKE_DONOR_COOKIE];
    const donorId = donorIdCookie ? Number(donorIdCookie) : null;

    if (!req.file) {
      const donor = await loadCurrentDonor(req);
      return res.render('admin/intake-upload', { binNumber, donor, error: 'A photo is required.' });
    }

    // Bins are never deleted (only retired via status), and /intake/open already created
    // this row — this is just a self-healing no-op guard, not an error path.
    await pool.query('INSERT INTO bins (bin_number) VALUES ($1) ON CONFLICT (bin_number) DO NOTHING', [binNumber]);

    const { key, url } = await uploadPhoto(req.file.buffer, req.file.mimetype);

    // AI output is a draft, never published automatically (Section 2).
    const { fields, raw } = await analyzeItemPhoto(req.file.buffer, req.file.mimetype);

    const { rows } = await pool.query(
      `INSERT INTO items (
         bin_number, donor_id, photo_key, photo_url, title, category, description, condition_notes,
         ai_raw_response, ai_confidence, price_original_cents, price_current_cents, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, 'draft')
       RETURNING id`,
      [
        binNumber,
        donorId,
        key,
        url,
        fields.title,
        fields.category,
        fields.description,
        fields.conditionNotes,
        raw ? JSON.stringify(raw) : null,
        fields.confidence,
        fields.priceCents
      ]
    );

    await ratchetBinPeak(pool, binNumber);

    res.redirect(`/admin/intake/${rows[0].id}`);
  })
);

router.get(
  '/intake/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM items WHERE id = $1 AND status = 'draft'`, [req.params.id]);
    if (rows.length === 0) {
      return res.redirect('/admin/intake');
    }
    res.render('admin/intake-review', { item: rows[0], categories: ALLOWED_CATEGORIES });
  })
);

router.get(
  '/bins',
  asyncHandler(async (req, res) => {
    const { rows: bins } = await pool.query(`
      SELECT b.*, COUNT(i.id) FILTER (
               WHERE i.status NOT IN ('picked_up', 'expired', 'removed')
             ) AS occupied_count
        FROM bins b
        LEFT JOIN items i ON i.bin_number = b.bin_number
       GROUP BY b.id
       ORDER BY b.bin_number ASC
    `);

    // Consolidation is only ever a suggestion computed here from live occupancy — nothing
    // physical moves and no status changes until a human taps "Flag for Consolidation"
    // below (Section 2).
    const binsWithSuggestions = bins.map((bin) => ({
      ...bin,
      consolidationSuggested: isConsolidationCandidate(bin)
    }));

    res.render('admin/bins', { bins: binsWithSuggestions, error: req.query.error || null });
  })
);

router.get(
  '/bins/:binNumber/items',
  asyncHandler(async (req, res) => {
    const binNumber = Number(req.params.binNumber);
    if (!Number.isInteger(binNumber)) {
      return res.redirect('/admin/bins');
    }

    // What's physically sitting in the bin right now — same definition of "occupied" used
    // everywhere else (bins.ejs, lib/bins.js), so this always matches the Occupied count.
    const { rows: items } = await pool.query(
      `SELECT * FROM items
        WHERE bin_number = $1 AND status NOT IN ('picked_up', 'expired', 'removed')
        ORDER BY created_at ASC`,
      [binNumber]
    );

    res.render('admin/bin-items', { binNumber, items, statusLabels: ITEM_STATUS_LABELS });
  })
);

router.get(
  '/bins/:binNumber/merge',
  asyncHandler(async (req, res) => {
    const binNumber = Number(req.params.binNumber);
    if (!Number.isInteger(binNumber)) {
      return res.redirect('/admin/bins');
    }
    res.render('admin/bin-merge', { binNumber, error: null });
  })
);

router.post(
  '/bins/:binNumber/merge',
  asyncHandler(async (req, res) => {
    const sourceBinNumber = Number(req.params.binNumber);
    if (!Number.isInteger(sourceBinNumber)) {
      return res.redirect('/admin/bins');
    }

    const targetBinNumber = req.body.target_bin_number ? Number(req.body.target_bin_number) : NaN;

    if (!Number.isInteger(targetBinNumber)) {
      return res.render('admin/bin-merge', {
        binNumber: sourceBinNumber,
        error: 'Enter a valid bin number to merge into.'
      });
    }

    if (targetBinNumber === sourceBinNumber) {
      return res.render('admin/bin-merge', {
        binNumber: sourceBinNumber,
        error: 'Choose a different bin to merge into.'
      });
    }

    // Any bin number works, same as opening a bin in Intake — auto-creates the row on
    // first use.
    await pool.query('INSERT INTO bins (bin_number) VALUES ($1) ON CONFLICT (bin_number) DO NOTHING', [
      targetBinNumber
    ]);

    // This assumes staff have already physically moved the items — same trust placed in
    // Inventory's own bin_number edit, just applied to everything currently in the source
    // bin at once. A human confirmed this by submitting the form (Section 2).
    await pool.query(
      `UPDATE items
          SET bin_number = $1, updated_at = NOW()
        WHERE bin_number = $2 AND status NOT IN ('picked_up', 'expired', 'removed')`,
      [targetBinNumber, sourceBinNumber]
    );

    await ratchetBinPeak(pool, targetBinNumber);

    res.redirect('/admin/bins');
  })
);

router.post(
  '/bins/:id/retire',
  asyncHandler(async (req, res) => {
    // Marking a bin "Empty" while it still holds real items wouldn't break anything
    // functionally (fulfillment only ever looks at item/order status, never bin status —
    // a sold item still shows its bin number in the queue regardless), but it would leave
    // the bin list itself lying about what's actually in there. Blocked here rather than
    // just documented, since nothing else would ever catch the mistake.
    const { rows } = await pool.query(
      `SELECT b.bin_number, COUNT(i.id) FILTER (
                WHERE i.status NOT IN ('picked_up', 'expired', 'removed')
              ) AS occupied_count
         FROM bins b
         LEFT JOIN items i ON i.bin_number = b.bin_number
        WHERE b.id = $1
        GROUP BY b.id`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.redirect('/admin/bins');
    }

    if (Number(rows[0].occupied_count) > 0) {
      return res.redirect(
        `/admin/bins?error=${encodeURIComponent(
          `Bin #${rows[0].bin_number} still has ${rows[0].occupied_count} item(s) in it — move or remove them first.`
        )}`
      );
    }

    // Retiring/consolidating a bin is a human decision made by tapping a button here —
    // software never moves a physical item or infers bin state changes (Section 2).
    await pool.query(`UPDATE bins SET status = 'retired' WHERE id = $1`, [req.params.id]);
    res.redirect('/admin/bins');
  })
);

router.post(
  '/bins/:id/flag-consolidation',
  asyncHandler(async (req, res) => {
    // Acknowledging a consolidation suggestion is itself the human confirmation — the
    // suggestion alone never changes bin status (Section 2).
    await pool.query(`UPDATE bins SET status = 'needs_consolidation' WHERE id = $1 AND status = 'active'`, [
      req.params.id
    ]);
    res.redirect('/admin/bins');
  })
);

router.post(
  '/bins/:id/resolve-consolidation',
  asyncHandler(async (req, res) => {
    // Tapped once staff have physically moved the bin's items elsewhere — the bin itself
    // is now empty and available for reuse. This does not move any item; reassigning an
    // item's bin_number remains a separate, explicit edit. peak_item_count resets since a
    // reused bin starts a fresh filling cycle — the old high-water mark no longer applies.
    await pool.query(
      `UPDATE bins
          SET status = 'active', last_consolidated_at = NOW(), peak_item_count = 0
        WHERE id = $1 AND status = 'needs_consolidation'`,
      [req.params.id]
    );
    res.redirect('/admin/bins');
  })
);

router.get(
  '/donations',
  asyncHandler(async (req, res) => {
    const registeredDonorId = req.query.donor_id ? Number(req.query.donor_id) : NaN;
    let registeredDonor = null;
    if (Number.isInteger(registeredDonorId)) {
      const { rows } = await pool.query('SELECT * FROM donors WHERE id = $1', [registeredDonorId]);
      registeredDonor = rows[0] || null;
    }

    // Search accepts either a phone number or a short donor id, since both appear on the
    // confirmation banner staff might have written down. A match goes straight to their
    // history instead of just confirming they exist.
    let searchError = null;
    const searchQuery = (req.query.q || '').trim();
    if (searchQuery) {
      const digitsOnly = searchQuery.replace(/\D/g, '');
      let donor = null;
      if (digitsOnly.length >= 7) {
        donor = await findDonorByPhone(digitsOnly);
      } else if (/^\d+$/.test(searchQuery)) {
        const { rows } = await pool.query('SELECT * FROM donors WHERE id = $1', [Number(searchQuery)]);
        donor = rows[0] || null;
      }

      if (donor) {
        return res.redirect(`/admin/donations/${donor.id}`);
      }
      searchError = `No donor found for "${searchQuery}".`;
    }

    const recentDonors = await getRecentDonors();
    res.render('admin/donations', {
      registeredDonor,
      error: searchError,
      recentDonors,
      searchQuery
    });
  })
);

router.post(
  '/donations',
  asyncHandler(async (req, res) => {
    const normalizedPhone = (req.body.phone_number || '').replace(/\D/g, '');

    if (normalizedPhone.length < 7) {
      const recentDonors = await getRecentDonors();
      return res.render('admin/donations', {
        registeredDonor: null,
        error: 'Enter a valid phone number.',
        recentDonors,
        searchQuery: ''
      });
    }

    // Keyed on phone_number so a repeat donor reuses their existing donor id instead of
    // getting a second one — this UPDATE is a no-op, just here so RETURNING still fires
    // on a conflict.
    const { rows } = await pool.query(
      `INSERT INTO donors (phone_number) VALUES ($1)
       ON CONFLICT (phone_number) DO UPDATE SET phone_number = EXCLUDED.phone_number
       RETURNING id`,
      [normalizedPhone]
    );

    res.redirect(`/admin/donations?donor_id=${rows[0].id}`);
  })
);

router.get(
  '/donations/:id',
  asyncHandler(async (req, res) => {
    const donorId = Number(req.params.id);
    if (!Number.isInteger(donorId)) {
      return res.redirect('/admin/donations');
    }

    const history = await getDonorHistory(donorId);
    if (!history) {
      return res.redirect('/admin/donations');
    }

    res.render('admin/donor-detail', { ...history, statusLabels: ITEM_STATUS_LABELS });
  })
);

const REPORT_SECTIONS = ['items', 'orders', 'donors', 'bins'];

router.get(
  '/reports',
  asyncHandler(async (req, res) => {
    const section = REPORT_SECTIONS.includes(req.query.section) ? req.query.section : 'items';

    const binNumberRaw = req.query.bin_number ? Number(req.query.bin_number) : null;
    const donorIdRaw = req.query.donor_id ? Number(req.query.donor_id) : null;

    const filters = {
      status: req.query.status || null,
      category: req.query.category || null,
      binNumber: Number.isInteger(binNumberRaw) ? binNumberRaw : null,
      donorId: Number.isInteger(donorIdRaw) ? donorIdRaw : null,
      startDate: req.query.start_date || null,
      endDate: req.query.end_date || null
    };

    let rows = [];
    if (section === 'items') rows = await getItemsReport(filters);
    else if (section === 'orders') rows = await getOrdersReport(filters);
    else if (section === 'donors') rows = await getDonorsReport(filters);
    else if (section === 'bins') rows = await getBinsReport(filters);

    // Only meaningful for the donors section, where "value sold" across everyone shown
    // is itself a useful number (e.g. "how much did all donors' items sell for this month").
    const totals =
      section === 'donors'
        ? rows.reduce(
            (acc, row) => ({
              itemsSoldCount: acc.itemsSoldCount + Number(row.items_sold_count),
              totalValueSoldCents: acc.totalValueSoldCents + Number(row.total_value_sold_cents)
            }),
            { itemsSoldCount: 0, totalValueSoldCents: 0 }
          )
        : null;

    res.render('admin/reports', {
      section,
      filters: req.query,
      rows,
      totals,
      itemStatuses: ITEM_STATUSES,
      itemStatusLabels: ITEM_STATUS_LABELS,
      orderStatuses: ORDER_STATUSES,
      binStatuses: BIN_STATUSES,
      categories: ALLOWED_CATEGORIES,
      resultLimit: REPORT_RESULT_LIMIT
    });
  })
);

// Covers the same window customers can actually book into (Section: MAX_PICKUP_DAYS_AHEAD
// in lib/pickup-schedule.js) — no point managing slots further out than anyone could pick.
router.get(
  '/schedule',
  asyncHandler(async (req, res) => {
    const bounds = pickupDateBounds();
    const dateStrings = pickupDateRange(bounds);

    const days = [];
    for (const dateStr of dateStrings) {
      const slots = await getSlotsForDate(pool, dateStr);
      days.push({
        date: dateStr,
        label: new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-US', {
          timeZone: 'UTC',
          weekday: 'long',
          month: 'long',
          day: 'numeric'
        }),
        slots
      });
    }

    res.render('admin/schedule', { days });
  })
);

router.post(
  '/schedule/:date/:startTime/toggle',
  asyncHandler(async (req, res) => {
    const { date, startTime } = req.params;
    const slots = await getSlotsForDate(pool, date);
    const slot = slots.find((s) => s.startTime === startTime);
    // A slot that isn't found (e.g. a stale page) has no current override — treat "toggle"
    // as opening it, the same effective result as if it had defaulted open all along.
    await setSlotOpen(pool, date, startTime, slot ? !slot.isOpen : true);
    res.redirect('/admin/schedule');
  })
);

router.post(
  '/schedule/:date/add',
  asyncHandler(async (req, res) => {
    const { date } = req.params;
    const startTime = req.body.start_time;
    if (startTime) {
      await setSlotOpen(pool, date, startTime, true);
    }
    res.redirect('/admin/schedule');
  })
);

module.exports = router;
