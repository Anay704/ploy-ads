// Seasons and holidays for the seasonal pick (PLAN.md §3). Pure and date-injected so tests
// can pin "today". Northern-hemisphere seasons by month, which fits the US stores we target.

export type Season = 'winter' | 'spring' | 'summer' | 'fall';

export type Holiday = { key: string; name: string; month: number; day: number };

// A campaign needs time to ramp, so a holiday closer than this is too late to build around.
export const MIN_HOLIDAY_LEAD_DAYS = 14;
// Further out than this, a holiday theme is off-message today.
export const MAX_HOLIDAY_LEAD_DAYS = 60;

// Fixed-date holidays only. Moving ones (Easter, Mother's Day, Thanksgiving) are left out
// rather than approximated; their products still count through their season.
const HOLIDAYS: (Holiday & { pattern: RegExp })[] = [
  { key: 'valentines', name: "Valentine's Day", month: 2, day: 14, pattern: /valentine|cupid|be mine/i },
  { key: 'st_patricks', name: "St. Patrick's Day", month: 3, day: 17, pattern: /st\.? patrick|shamrock/i },
  { key: 'independence', name: 'Fourth of July', month: 7, day: 4, pattern: /americana|4th of july|fourth of july|independence|freedom|patriot|stars (?:and|&) stripes/i },
  {
    key: 'halloween',
    name: 'Halloween',
    month: 10,
    day: 31,
    pattern: /halloween|spooky|\bboo\b|witch|ghost|pumpkin|skelet|\bbones?\b|spider|itsy bitsy|haunt|\bbats?\b|trick or treat/i,
  },
  {
    key: 'christmas',
    name: 'Christmas',
    month: 12,
    day: 25,
    pattern: /christmas|xmas|santa|merry|jolly|snowm[ae]n|reindeer|\bholly\b|mistletoe|gingerbread|candy cane|\bholiday\b/i,
  },
];

const SEASON_WORDS: [Season, RegExp][] = [
  ['fall', /\b(fall|autumn)\b/i],
  ['winter', /\bwinter\b/i],
  ['spring', /\bspring\b/i],
  ['summer', /\bsummer\b/i],
];

export function currentSeason(today: Date): Season {
  const m = today.getUTCMonth() + 1;
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'fall';
  return 'winter';
}

/** Days from today to the holiday's next occurrence (0 on the day itself). */
export function daysUntil(h: Holiday, today: Date): number {
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  let next = Date.UTC(today.getUTCFullYear(), h.month - 1, h.day);
  if (next < start) next = Date.UTC(today.getUTCFullYear() + 1, h.month - 1, h.day);
  return Math.round((next - start) / 86_400_000);
}

/** Holidays a piece of text is themed on: a product title and tags, or a collection title. */
export function holidaysIn(text: string): Holiday[] {
  return HOLIDAYS.filter((h) => h.pattern.test(text)).map(({ key, name, month, day }) => ({ key, name, month, day }));
}

export function seasonIn(text: string): Season | null {
  return SEASON_WORDS.find(([, re]) => re.test(text))?.[0] ?? null;
}

/** Too late to launch around: the holiday is under MIN_HOLIDAY_LEAD_DAYS away. */
export function holidayTooClose(h: Holiday, today: Date): boolean {
  return daysUntil(h, today) < MIN_HOLIDAY_LEAD_DAYS;
}

/** A holiday worth building a campaign around now: far enough to ramp, close enough to matter. */
export function holidayInWindow(h: Holiday, today: Date): boolean {
  const d = daysUntil(h, today);
  return d >= MIN_HOLIDAY_LEAD_DAYS && d <= MAX_HOLIDAY_LEAD_DAYS;
}

// Products made for one half of the year (matched on title, type and tags). Seen live on
// Allbirds on 2026-11-04: dusty-pink flip-flops promised "sunny beach walks" in a November
// campaign. Year-round materials (wool, flannel, fleece) are deliberately not listed.
const WARM_ONLY = /flip[- ]?flops?|sandals?|\bslides?\b|swim|bikini|board ?shorts|sun ?hats?|\bbeach\b/i;
const COLD_ONLY = /puffer|parka|snow ?boots?|beanie|mittens?|ski (?:jacket|pants)|thermal|insulated (?:jacket|boot)/i;

/** Why a product is wrong for today's season, or null if it fits. */
export function offSeason(text: string, today: Date): string | null {
  const season = currentSeason(today);
  const cold = season === 'fall' || season === 'winter';
  if (cold && WARM_ONLY.test(text)) return `a warm-weather product, and it's ${season}`;
  if (!cold && COLD_ONLY.test(text)) return `a cold-weather product, and it's ${season}`;
  return null;
}
