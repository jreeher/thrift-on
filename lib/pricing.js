const BASE_PRICES = {
  books: 300,
  kitchenware: 800,
  home_decor: 1000,
  tools: 1500,
  electronics: 2000,
  toys: 600,
  furniture: 4000,
  clothing: 1200,
  other: 800
};

const ALLOWED_CATEGORIES = Object.keys(BASE_PRICES);

function basePriceForCategory(category) {
  return BASE_PRICES[category] !== undefined ? BASE_PRICES[category] : BASE_PRICES.other;
}

// A bad AI price guess (or a bad manual entry) can never produce an absurd price —
// clamp to 0.15x-8x the category base (Section 7). Wide on purpose: real thrift items
// within one category span way more than a tight band around the base (a $3 t-shirt and
// a $150 jacket are both "clothing"), so this should only catch genuine outliers, not
// flatten normal price variation. Tune the multipliers here if items still come through
// too compressed or too spread out.
function clampSuggestedPrice(category, suggestedCents) {
  const base = basePriceForCategory(category);
  if (!Number.isFinite(suggestedCents) || suggestedCents <= 0) {
    return base;
  }
  const min = Math.round(base * 0.15);
  const max = Math.round(base * 8);
  return Math.min(Math.max(Math.round(suggestedCents), min), max);
}

// Weekly markdown reaches its floor at week 4 (20% of original) and holds there
// indefinitely — items no longer expire out of the shop on their own; they just stop
// getting cheaper. MARKDOWN_WEEKS is the last week a *new* markdown happens, matching
// the point currentPriceCents' floor takes over.
const MARKDOWN_WEEKS = 4;
const WEEKLY_DROP_FRACTION = 0.2;
const MIN_PRICE_FRACTION = 0.2;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

function weeksElapsedSince(listedAt, now = new Date()) {
  if (!listedAt) return 0;
  const elapsedMs = now.getTime() - new Date(listedAt).getTime();
  return Math.max(0, Math.floor(elapsedMs / MS_PER_WEEK));
}

// price_current = original * (1 - 0.20 * weeks_elapsed), floored at 20% of original
// starting week 4 and never going lower, however long the item sits (Section 7).
function currentPriceCents(priceOriginalCents, weeksElapsed) {
  const fraction = Math.max(MIN_PRICE_FRACTION, 1 - WEEKLY_DROP_FRACTION * weeksElapsed);
  return Math.round(priceOriginalCents * fraction);
}

// Next markdown price/date, purely for display (the storefront "drops to $X on <date>"
// selling point, Section 11). Returns null once the item has hit its floor — there's no
// further markdown coming, ever.
function nextMarkdown(priceOriginalCents, listedAt, now = new Date()) {
  if (!listedAt) return null;
  const weeksElapsed = weeksElapsedSince(listedAt, now);
  if (weeksElapsed >= MARKDOWN_WEEKS) return null;

  const nextWeek = weeksElapsed + 1;
  const listedAtMs = new Date(listedAt).getTime();

  return {
    nextPriceCents: currentPriceCents(priceOriginalCents, nextWeek),
    nextDate: new Date(listedAtMs + nextWeek * MS_PER_WEEK)
  };
}

module.exports = {
  BASE_PRICES,
  ALLOWED_CATEGORIES,
  basePriceForCategory,
  clampSuggestedPrice,
  MARKDOWN_WEEKS,
  MIN_PRICE_FRACTION,
  weeksElapsedSince,
  currentPriceCents,
  nextMarkdown
};
