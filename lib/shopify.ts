// Shopify research (PLAN.md §3): detect, fetch, slim, filter, rank. Pure functions are
// exported for tests; nothing here touches the database or an LLM.

import { MIN_HOLIDAY_LEAD_DAYS, currentSeason, daysUntil, holidayInWindow, holidaysIn, holidayTooClose, seasonIn, type Holiday, type Season } from './seasons';

export type ShopifyImage = { id: number; src: string; position: number; isHero: boolean };

export type SlimProduct = {
  shopifyId: number;
  handle: string;
  title: string;
  productType: string;
  tags: string[];
  price: number;
  compareAtPrice: number | null; // only set when it is a real discount (above price)
  available: boolean;
  description: string;
  images: ShopifyImage[];
  publishedAt: string;
};

export type RankedProduct = SlimProduct & { rank: number; rankReason: string };

export type Goal = 'seasonal' | 'sale' | 'evergreen';

// ── URL normalization ────────────────────────────────────────────────────────

export type StoreTarget = { origin: string; domain: string; productHandle: string | null };

/** Accepts "loopycases.com", "https://www.loopycases.com/", or a /products/<handle> URL. */
export function parseStoreUrl(input: string): StoreTarget {
  const raw = input.trim();
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  const match = url.pathname.match(/\/products\/([^/?#.]+)/);
  return {
    origin: url.origin,
    domain: url.hostname.replace(/^www\./, '').toLowerCase(),
    productHandle: match ? decodeURIComponent(match[1]) : null,
  };
}

// ── Detection and fetching ───────────────────────────────────────────────────

const UA = { 'user-agent': 'Mozilla/5.0 (compatible; PloyAdsResearch/0.1)' };

async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers: { ...UA, accept: 'application/json' }, redirect: 'follow' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export type ShopMeta = { name: string; description: string; domain: string; url: string };

/**
 * A store is Shopify only if both /meta.json and /products.json return the expected shapes.
 * Returns the origin after redirects (loopycases.com → www.loopycases.com) with the meta.
 */
export async function detectShopify(origin: string): Promise<{ origin: string; meta: ShopMeta } | null> {
  // Follow the homepage redirect first so later requests hit the canonical host.
  let canonical = origin;
  try {
    const res = await fetch(origin, { headers: UA, redirect: 'follow' });
    canonical = new URL(res.url).origin;
  } catch {
    return null;
  }
  const [meta, products] = await Promise.all([getJson(`${canonical}/meta.json`), getJson(`${canonical}/products.json?limit=1`)]);
  const m = meta as Partial<ShopMeta> & { myshopify_domain?: string } | null;
  const p = products as { products?: unknown } | null;
  if (!m || typeof m.name !== 'string' || !m.myshopify_domain || !Array.isArray(p?.products)) return null;
  return { origin: canonical, meta: { name: m.name, description: m.description ?? '', domain: m.domain ?? '', url: m.url ?? canonical } };
}

type RawVariant = { price: string; compare_at_price: string | null; available?: boolean };
type RawImage = { id: number; src: string; position: number; variant_ids: number[] };
export type RawProduct = {
  id: number;
  handle: string;
  title: string;
  body_html: string | null;
  product_type: string;
  tags: string[] | string; // array in products.json, comma-separated string in /products/<handle>.json
  published_at: string;
  variants: RawVariant[];
  images: RawImage[];
};

const MAX_PAGES = 40; // 10,000 products; a guard against a store that never returns an empty page

/** Pages through /products.json?limit=250 until a page comes back empty. */
export async function fetchCatalog(origin: string): Promise<RawProduct[]> {
  const all: RawProduct[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = (await getJson(`${origin}/products.json?limit=250&page=${page}`)) as { products?: RawProduct[] } | null;
    if (!data?.products?.length) break;
    all.push(...data.products);
  }
  return all;
}

export async function fetchProduct(origin: string, handle: string): Promise<RawProduct | null> {
  const data = (await getJson(`${origin}/products/${encodeURIComponent(handle)}.json`)) as { product?: RawProduct } | null;
  return data?.product ?? null;
}

// ── Slimming and tag filtering ───────────────────────────────────────────────

// Internal or merchandising-system tags that mean nothing to a shopper or an ad.
const INTERNAL_TAG_PATTERNS = [
  /^contains /i, // "Contains i13 6.7": device-compatibility flags
  /UNI$/, // "... 6.1 UNI"
  /^pf-/i, // page-builder flags, e.g. pf-plp-exp
  /^pc-/i, // integration flags, e.g. pc-glbe-giftcard
  /^testpromo$/i,
  /:/, // key:value system tags, e.g. auto-select:off
  /^is-/i, // is-apple
  /^(i|s)\d{1,2}\b/i, // device codes: i13, s24
  /\b\d+\.\d\b/, // screen sizes: 6.1, 6.7
  /^lte$/i,
];

/** Drops internal tags and lowercases the rest, so ranking and the LLM see shopper-facing tags only. */
export function filterTags(tags: string[] | string): string[] {
  const list = Array.isArray(tags) ? tags : tags.split(',');
  const kept = new Set<string>();
  for (const t of list) {
    const tag = t.trim();
    if (!tag || INTERNAL_TAG_PATTERNS.some((re) => re.test(tag))) continue;
    kept.add(tag.toLowerCase());
  }
  return [...kept];
}

export function stripHtml(html: string | null, max = 600): string {
  const text = (html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function slimProduct(p: RawProduct): SlimProduct {
  // Price and discount come from the cheapest available variant, so a sale badge is never
  // shown for a variant the shopper can't buy.
  const variants = p.variants.filter((v) => v.available !== false);
  const v = [...(variants.length ? variants : p.variants)].sort((a, b) => +a.price - +b.price)[0];
  const price = Number(v?.price ?? 0);
  const compare = v?.compare_at_price ? Number(v.compare_at_price) : null;
  return {
    shopifyId: p.id,
    handle: p.handle,
    title: p.title,
    productType: p.product_type,
    tags: filterTags(p.tags),
    price,
    compareAtPrice: compare !== null && compare > price ? compare : null,
    available: p.variants.some((x) => x.available !== false),
    description: stripHtml(p.body_html),
    images: [...p.images]
      .sort((a, b) => a.position - b.position)
      .map((i) => ({ id: i.id, src: i.src.split('?')[0], position: i.position, isHero: i.variant_ids.length === 0 })),
    publishedAt: p.published_at,
  };
}

// ── Images ───────────────────────────────────────────────────────────────────

/** Shopify CDN URL at 1080px wide. GIFs need format=png: the CDN ignores format=jpg for them (NOTES M0). */
export function imageFetchUrl(src: string): string {
  const fmt = /\.gif$/i.test(src.split('?')[0]) ? 'png' : 'jpg';
  return `${src}${src.includes('?') ? '&' : '?'}width=1080&format=${fmt}`;
}

/**
 * The photo an ad is built from. Hero shots (no variant_ids: the case on a phone, in a hand)
 * come first, still images before GIFs; studio cutouts are the fallback. Position 1 is never
 * taken blindly, because some stores put an animated GIF or a promo graphic there.
 */
export function pickSourceImage(p: Pick<SlimProduct, 'images'>): ShopifyImage | null {
  const isGif = (i: ShopifyImage) => /\.gif$/i.test(i.src);
  const order = [
    ...p.images.filter((i) => i.isHero && !isGif(i)),
    ...p.images.filter((i) => i.isHero && isGif(i)),
    ...p.images.filter((i) => !i.isHero && !isGif(i)),
    ...p.images.filter((i) => !i.isHero && isGif(i)),
  ];
  return order[0] ?? null;
}

// ── Ranking and goal ─────────────────────────────────────────────────────────

const heroCount = (p: SlimProduct) => p.images.filter((i) => i.isHero).length;

const TIERS = [
  { tag: 'best seller', reason: 'tagged best seller' },
  { tag: 'new', reason: 'tagged new' },
  { tag: 'limited', reason: 'limited edition' },
];

/** The most common product_type among available products ("cases" for Loopy). */
export function dominantType(products: SlimProduct[]): string | null {
  const counts = new Map<string, number>();
  for (const p of products) if (p.available && p.productType) counts.set(p.productType, (counts.get(p.productType) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * Ranks available products of the target type: best seller > new > limited > the rest, with
 * "last call" pushed below everything else. Ties break on having at least 3 hero images,
 * then on recency. A pinned product (from a /products/<handle> URL) is always #1.
 */
export function rankProducts(products: SlimProduct[], opts: { type?: string | null; pinnedHandle?: string | null } = {}): RankedProduct[] {
  const type = opts.type === undefined ? dominantType(products) : opts.type;
  const pool = products.filter((p) => p.available && (!type || p.productType === type || p.handle === opts.pinnedHandle));

  const tierOf = (p: SlimProduct) => {
    if (p.handle === opts.pinnedHandle) return -1;
    const lastCall = p.tags.includes('last call');
    const i = TIERS.findIndex((t) => p.tags.includes(t.tag));
    const base = i === -1 ? TIERS.length : i;
    return lastCall ? TIERS.length + 1 + base : base;
  };
  const sorted = [...pool].sort(
    (a, b) =>
      tierOf(a) - tierOf(b) ||
      Number(heroCount(b) >= 3) - Number(heroCount(a) >= 3) ||
      Date.parse(b.publishedAt) - Date.parse(a.publishedAt) ||
      a.shopifyId - b.shopifyId,
  );

  return sorted.map((p, i) => {
    const parts: string[] = [];
    if (p.handle === opts.pinnedHandle) parts.push('the product you linked');
    const tier = TIERS.find((t) => p.tags.includes(t.tag));
    if (tier) parts.push(tier.reason);
    if (p.compareAtPrice) parts.push(`on sale ($${p.compareAtPrice.toFixed(2)} → $${p.price.toFixed(2)})`);
    if (p.tags.includes('last call')) parts.push('last call (ranked down)');
    const heroes = heroCount(p);
    parts.push(heroes >= 3 ? `${heroes} lifestyle photos` : `only ${heroes} lifestyle photo${heroes === 1 ? '' : 's'}`);
    parts.push(`published ${p.publishedAt.slice(0, 10)}`);
    return { ...p, rank: i + 1, rankReason: parts.join(', ') };
  });
}

// ── Seasonal collections ─────────────────────────────────────────────────────

/** A store collection whose title names a season or a holiday, with the ids of its products. */
export type SeasonalCollection = { handle: string; title: string; season: Season | null; holidays: Holiday[]; productIds: Set<number> };

/**
 * The store's own seasonal merchandising ("Fall Favorites", "Holiday | Neutral Tones") is the
 * signal for the seasonal pick: it is the merchant's call, not a guess from product titles.
 */
export async function fetchSeasonalCollections(origin: string): Promise<SeasonalCollection[]> {
  const list: { handle: string; title: string }[] = [];
  for (let page = 1; page <= 10; page++) {
    const data = (await getJson(`${origin}/collections.json?limit=250&page=${page}`)) as { collections?: { handle: string; title: string }[] } | null;
    if (!data?.collections?.length) break;
    list.push(...data.collections);
  }
  const seasonal = list
    .map((c) => ({ handle: c.handle, title: c.title, season: seasonIn(c.title), holidays: holidaysIn(c.title) }))
    .filter((c) => c.season || c.holidays.length);
  return Promise.all(
    seasonal.map(async (c) => {
      const ids = new Set<number>();
      for (let page = 1; page <= MAX_PAGES; page++) {
        const data = (await getJson(`${origin}/collections/${c.handle}/products.json?limit=250&page=${page}`)) as { products?: { id: number }[] } | null;
        if (!data?.products?.length) break;
        for (const p of data.products) ids.add(p.id);
      }
      return { ...c, productIds: ids };
    }),
  );
}

// ── The 3 picks ──────────────────────────────────────────────────────────────

export type Slot = 'pinned' | 'best_seller' | 'newest' | 'seasonal' | 'next_best';

export type ProductPick = RankedProduct & { slot: Slot; pickReason: string; seasonal?: { season?: Season; holiday?: Holiday } };

export type PickResult = { picks: ProductPick[]; ordered: RankedProduct[]; skipped: { title: string; reason: string }[] };

const isClearance = (p: SlimProduct) => p.tags.includes('last call');
const themeOf = (p: SlimProduct) => holidaysIn(`${p.title} ${p.tags.join(' ')}`);

// "Cocoa Checkered" and "Caramel Checkered" would make two near-identical ads, so a pick
// that shares a title word (plural-insensitive) with an earlier pick is passed over.
function titleWords(title: string): Set<string> {
  return new Set(title.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3).map((w) => w.replace(/s$/, '')));
}
function looksAlike(a: SlimProduct, b: SlimProduct): boolean {
  const wb = titleWords(b.title);
  return [...titleWords(a.title)].some((w) => wb.has(w));
}

/**
 * Picks a mix for round 1 (PLAN.md §3): one best seller, one of the newest products and one
 * fresh seasonal product, so the first 6 ads show range instead of three similar hits.
 * - Products themed on a holiday under 14 days away are skipped everywhere: too late to ramp.
 * - "last call" clearance stock is only used if nothing else fills a slot.
 * - A pinned product (from a /products/<handle> URL) takes the first place.
 * `ordered` is the full ranking with the picks first; it becomes products.rank.
 */
export function pickMix(
  products: SlimProduct[],
  opts: { today: Date; collections?: SeasonalCollection[]; pinnedHandle?: string | null },
): PickResult {
  const ranked = rankProducts(products, { pinnedHandle: opts.pinnedHandle });
  const collections = opts.collections ?? [];
  const skipped: PickResult['skipped'] = [];

  const eligible = ranked.filter((p) => {
    const late = themeOf(p).find((h) => holidayTooClose(h, opts.today));
    if (late && p.handle !== opts.pinnedHandle) {
      const days = daysUntil(late, opts.today);
      skipped.push({ title: p.title, reason: `${late.name} theme, ${days} day${days === 1 ? '' : 's'} away (needs ${MIN_HOLIDAY_LEAD_DAYS}+ to ramp)` });
      return false;
    }
    return true;
  });
  const fresh = eligible.filter((p) => !isClearance(p));

  const picks: ProductPick[] = [];
  const take = (cands: RankedProduct[], slot: Slot, reason: (p: RankedProduct) => string, seasonal?: (p: RankedProduct) => ProductPick['seasonal']) => {
    if (picks.length >= 3) return;
    const p = cands.find((c) => !picks.some((x) => x.shopifyId === c.shopifyId || looksAlike(x, c)));
    if (p) picks.push({ ...p, slot, pickReason: reason(p), seasonal: seasonal?.(p) });
  };
  const photos = (p: SlimProduct) => `${heroCount(p)} lifestyle photos`;
  const byNewest = (list: RankedProduct[]) =>
    [...list].sort((a, b) => Number(heroCount(b) >= 3) - Number(heroCount(a) >= 3) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

  const pinned = eligible.find((p) => p.handle === opts.pinnedHandle);
  if (pinned) picks.push({ ...pinned, slot: 'pinned', pickReason: 'the product you linked' });

  take(
    fresh.filter((p) => p.tags.includes('best seller')),
    'best_seller',
    (p) => `best seller: tagged best seller, ${photos(p)}`,
  );

  take(byNewest(fresh), 'newest', (p) => `newest: published ${p.publishedAt.slice(0, 10)}${p.tags.includes('new') ? ', tagged new' : ''}, ${photos(p)}`);

  // Seasonal: the current season's collection first ("prefer the fall collection"), then a
  // collection or product theme for a holiday 14-60 days out.
  const season = currentSeason(opts.today);
  for (const c of collections.filter((c) => c.season === season)) {
    take(
      byNewest(fresh.filter((p) => c.productIds.has(p.shopifyId))),
      'seasonal',
      (p) => `seasonal: in "${c.title}", and ${season} is the current season; published ${p.publishedAt.slice(0, 10)}`,
      () => ({ season }),
    );
  }
  for (const c of collections.filter((c) => c.holidays.some((h) => holidayInWindow(h, opts.today)))) {
    const h = c.holidays.find((x) => holidayInWindow(x, opts.today))!;
    take(
      byNewest(fresh.filter((p) => c.productIds.has(p.shopifyId))),
      'seasonal',
      (p) => `seasonal: in "${c.title}", ${h.name} is ${daysUntil(h, opts.today)} days away; published ${p.publishedAt.slice(0, 10)}`,
      () => ({ holiday: h }),
    );
  }
  take(
    byNewest(fresh.filter((p) => themeOf(p).some((h) => holidayInWindow(h, opts.today)))),
    'seasonal',
    (p) => {
      const h = themeOf(p).find((x) => holidayInWindow(x, opts.today))!;
      return `seasonal: ${h.name} theme, ${daysUntil(h, opts.today)} days away`;
    },
    (p) => ({ holiday: themeOf(p).find((x) => holidayInWindow(x, opts.today)) }),
  );

  // Any slot still empty takes the next product by rank, clearance last.
  take([...fresh, ...eligible.filter(isClearance)], 'next_best', (p) => `next best by rank: ${p.rankReason}`);
  take([...fresh, ...eligible.filter(isClearance)], 'next_best', (p) => `next best by rank: ${p.rankReason}`);

  const pickIds = new Set(picks.map((p) => p.shopifyId));
  const ordered = [...picks, ...ranked.filter((p) => !pickIds.has(p.shopifyId))].map((p, i) => ({
    ...p,
    rank: i + 1,
    rankReason: 'pickReason' in p ? (p as ProductPick).pickReason : p.rankReason,
  }));
  return { picks: picks.map((p, i) => ({ ...p, rank: i + 1, rankReason: p.pickReason })), ordered, skipped };
}

/**
 * Seasonal if a seasonal pick is in play (its season is current or its holiday is in window),
 * Sale only if a pick has a real discount and isn't clearance, otherwise Evergreen.
 */
export function suggestGoal(picks: ProductPick[]): Goal {
  if (picks.some((p) => p.slot === 'seasonal' && p.seasonal)) return 'seasonal';
  if (picks.some((p) => p.compareAtPrice !== null && !isClearance(p))) return 'sale';
  return 'evergreen';
}
