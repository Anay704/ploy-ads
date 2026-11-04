// Shopify research (PLAN.md §3): detect, fetch, slim, filter, rank. Pure functions are
// exported for tests; nothing here touches the database or an LLM.

import { MIN_HOLIDAY_LEAD_DAYS, offSeason, currentSeason, daysUntil, holidayInWindow, holidaysIn, holidayTooClose, seasonIn, type Holiday, type Season } from './seasons';

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

const MAX_PAGES = 40; // 10,000 products: enough to pick from, and research stays under ~30s

export type Catalog = { products: RawProduct[]; truncated: boolean };

/**
 * Pages through /products.json?limit=250 until a page comes back empty. A failed page (rate
 * limit, network) is retried once, since a silent stop would look like a small catalog. A huge
 * catalog stops at MAX_PAGES and is marked truncated: we pick from what was fetched and say so.
 */
export async function fetchCatalog(origin: string): Promise<Catalog> {
  const all: RawProduct[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${origin}/products.json?limit=250&page=${page}`;
    let data = (await getJson(url)) as { products?: RawProduct[] } | null;
    if (!data) {
      await new Promise((r) => setTimeout(r, 1500));
      data = (await getJson(url)) as { products?: RawProduct[] } | null;
    }
    if (!data?.products?.length) return { products: all, truncated: false };
    all.push(...data.products);
  }
  return { products: all, truncated: true };
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
  // Warehouse, feed and app tags (seen on Allbirds, Gymshark, Brooklinen, Kylie): dates, SKUs,
  // pipes, hashes and underscores never mean anything to a shopper.
  /\d{1,2}[./]\d{1,2}([./]\d{2,4})?/, // 11/3/26, 5.26.26
  /\d{4,}/, // SKUs and ids
  /[#|_@()]/,
  /\b(wave|truck|cross ?dock|ecdc|dns|oos|onsite|stock|blocklist|exclude|hide|nosto|feedonomics|yotpo|shoprunner|fraud|redirect|bucket|wishlist|qualifier|ineligible|promo|checkout|auto-bundle|all-products|retail single|feed|module|slider|duplify|export|hidereviewsummary)\b/i,
  /^(dg|tts)$|^y(blocklist|group|crf)/i, // internal codes: "ygroup_…", "yblocklist"
];

// Stores name the same merchandising flag differently; ranking reads one spelling.
const TAG_SYNONYMS: [RegExp, string][] = [
  [/^(best[- ]?sellers?|top[- ]?sellers?|most[- ]loved|fan[- ]favou?rites?)$/i, 'best seller'],
  [/^(new[- ]?(arrivals?|releases?|in)|newarrivals|just[- ]dropped)$/i, 'new'],
  [/last call|final sale|clearance/i, 'last call'], // Brooklinen: "active last call", "final sale"
];

/** Drops internal tags and lowercases the rest, so ranking and the LLM see shopper-facing tags only. */
export function filterTags(tags: string[] | string): string[] {
  const list = Array.isArray(tags) ? tags : tags.split(',');
  const kept = new Set<string>();
  for (const t of list) {
    const tag = t.trim();
    if (!tag || INTERNAL_TAG_PATTERNS.some((re) => re.test(tag))) continue;
    kept.add(TAG_SYNONYMS.find(([re]) => re.test(tag))?.[1] ?? tag.toLowerCase());
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

/**
 * Merchandising tags that actually single products out. On Gymshark "most-loved" and
 * "new-releases" sit on nearly every product (navigation tags), which made "One of your 2685
 * best sellers"; a tag on more than half of a 20+ product pool is ignored for ranking.
 */
export function signalTags(pool: SlimProduct[]): Set<string> {
  const tags = new Set(TIERS.map((t) => t.tag));
  if (pool.length < 20) return tags;
  for (const t of [...tags]) if (pool.filter((p) => p.tags.includes(t)).length > pool.length / 2) tags.delete(t);
  return tags;
}

const TIERS = [
  { tag: 'best seller', reason: 'tagged best seller' },
  { tag: 'new', reason: 'tagged new' },
  { tag: 'limited', reason: 'limited edition' },
];

// ── Core category ────────────────────────────────────────────────────────────
// "Pick from the most common product_type" only worked for single-category stores like Loopy.
// Death Wish Coffee has more apparel (37) than coffee (35), Brooklinen lists 83 "Content"
// items, Gymshark's types are paths. So products are grouped by a type family, the store's
// core family is found from its own brand research, and everything else is ranked below it.

const GENDER = /^(wo)?m[ae]ns?'?s?$|^(unisex|kids?|girls?|boys?|baby|adults?)$/i;

/** The meaningful segments of a type: "Womens>Apparel>Leggings>full_length" → Apparel, Leggings, full_length. */
function typeSegments(type: string): string[] {
  return (type ?? '').split('>').map((s) => s.trim()).filter((s) => s && !GENDER.test(s));
}

/** What the product is, for people and the profile call: "Leggings", not the whole path. */
export function cleanType(type: string): string {
  const seg = typeSegments(type);
  if (seg.length > 2 && seg[seg.length - 1].includes('_')) seg.pop(); // "full_length" is a detail
  return seg[seg.length - 1] ?? '';
}

/** The family products are pooled by: the first meaningful segment ("apparel"), or the flat type. */
export function typeFamily(type: string): string {
  return (typeSegments(type)[0] ?? '').toLowerCase();
}

const NON_PRODUCT = /^(content|gift ?cards?|e-?gift.*|samples?|package.?protection|.*package_protection|shipping.*|insurance|returns?|services?|donations?)$/i;
const NON_PRODUCT_TITLE = /gift card|e-?gift|package protection|shipping protection|route protection/i;
const BUNDLE = /\bbundles?\b/i;
const MERCH = /apparel|merch|accessor|gift|mug|drinkware|sticker|sock|hat|cap|tee|shirt|hoodie|clothing|tumbler|swag/i;

export type ProductKind = 'product' | 'bundle' | 'non_product';
export function productKind(p: Pick<SlimProduct, 'productType' | 'title' | 'price'>): ProductKind {
  if (NON_PRODUCT.test(cleanType(p.productType)) || NON_PRODUCT.test(typeFamily(p.productType)) || NON_PRODUCT_TITLE.test(p.title) || p.price <= 0) return 'non_product';
  if (BUNDLE.test(p.productType) || BUNDLE.test(p.title)) return 'bundle';
  return 'product';
}

// Words a brand uses for a family it doesn't name: Gymshark sells "workout clothes", not "apparel".
const FAMILY_SYNONYMS: Record<string, string[]> = {
  apparel: ['clothe', 'clothing', 'wear', 'activewear', 'gymwear', 'outfit', 'legging', 'top'],
  shoe: ['sneaker', 'footwear', 'trainer'],
  sheet: ['bedding', 'linen'],
  skincare: ['skin'],
};

const stem = (w: string) => w.toLowerCase().replace(/(ies)$/, 'y').replace(/(?<=[^s])s$/, '');
const words = (text: string) => new Set(text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3).map(stem));

export type Core = { family: string; label: string; count: number; reason: string };

/**
 * The store's core product family. A family named in the brand's own words (value prop,
 * audience, description) wins, non-merch first ("the world's strongest coffee" → coffee, not
 * apparel). Otherwise the largest non-merch family, otherwise the largest family. Bundles and
 * non-products never count.
 */
export function coreFamily(products: SlimProduct[], brandText = ''): Core | null {
  const counts = new Map<string, { count: number; label: string }>();
  for (const p of products) {
    if (!p.available || productKind(p) !== 'product') continue;
    const f = typeFamily(p.productType);
    if (!f) continue;
    const c = counts.get(f) ?? { count: 0, label: typeSegments(p.productType)[0] };
    c.count++;
    counts.set(f, c);
  }
  const brand = words(brandText);
  const fams = [...counts.entries()].map(([family, c]) => ({
    family,
    ...c,
    named: [...words(family)].some((w) => brand.has(w) || (FAMILY_SYNONYMS[w] ?? []).some((x) => brand.has(x))),
    merch: MERCH.test(family),
  }));
  const by = (list: typeof fams) => list.sort((a, b) => Number(a.merch) - Number(b.merch) || b.count - a.count)[0];
  // A named family must be a real part of the range (10%+ of the largest), so "clothes and
  // accessories" doesn't hand the picks to 300 keyrings next to 2,700 pieces of apparel.
  const largest = Math.max(0, ...fams.map((f) => f.count));
  const named = by(fams.filter((f) => f.named && f.count >= largest * 0.1));
  const chosen = named ?? by(fams.filter((f) => !f.merch)) ?? by(fams);
  if (!chosen) return null;
  return {
    family: chosen.family,
    label: chosen.label,
    count: chosen.count,
    reason: named ? 'named in your brand description' : chosen.merch ? 'your largest category' : 'your largest non-merch category',
  };
}

/** 0 core, 1 other products, 2 merch, 3 bundles, 4 non-products: the order picks fall back through. */
function priorityOf(p: SlimProduct, core: string | null): number {
  const kind = productKind(p);
  if (kind === 'non_product') return 4;
  if (kind === 'bundle') return 3;
  const f = typeFamily(p.productType);
  if (!core || f === core) return 0;
  return MERCH.test(f) ? 2 : 1;
}

/**
 * Ranks available products: the core family first, then other products, merch, bundles and
 * non-products. Within each: best seller > new > limited > the rest, with "last call" pushed
 * down; ties break on having at least 3 hero images, then on recency. A pinned product (from a
 * /products/<handle> URL) is always #1.
 */
export function rankProducts(products: SlimProduct[], opts: { core?: string | null; brandText?: string; pinnedHandle?: string | null } = {}): RankedProduct[] {
  const core = opts.core === undefined ? (coreFamily(products, opts.brandText)?.family ?? null) : opts.core;
  const pool = products.filter((p) => p.available);
  const signals = signalTags(pool.filter((p) => !core || typeFamily(p.productType) === core));

  const tierOf = (p: SlimProduct) => {
    if (p.handle === opts.pinnedHandle) return -1;
    const lastCall = p.tags.includes('last call');
    const i = TIERS.findIndex((t) => signals.has(t.tag) && p.tags.includes(t.tag));
    const base = i === -1 ? TIERS.length : i;
    return lastCall ? TIERS.length + 1 + base : base;
  };
  const prio = (p: SlimProduct) => (p.handle === opts.pinnedHandle ? -1 : priorityOf(p, core));
  const sorted = [...pool].sort(
    (a, b) =>
      prio(a) - prio(b) ||
      tierOf(a) - tierOf(b) ||
      Number(heroCount(b) >= 3) - Number(heroCount(a) >= 3) ||
      Date.parse(b.publishedAt) - Date.parse(a.publishedAt) ||
      a.shopifyId - b.shopifyId,
  );

  const OUTSIDE = ['', 'outside your core range', 'merch, ranked below your core range', 'a bundle, ranked last', 'not a product'];
  return sorted.map((p, i) => {
    const parts: string[] = [];
    if (p.handle === opts.pinnedHandle) parts.push('the product you linked');
    else if (prio(p) > 0) parts.push(OUTSIDE[prio(p)]);
    const tier = TIERS.find((t) => signals.has(t.tag) && p.tags.includes(t.tag));
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
 * What a marketer calls the collection. Long internal titles ("Collection Data - Fall
 * Collection - Brushed Flannel Sheets" on Brooklinen) keep their seasonal segment, and a
 * trailing "Collection" is dropped because the reason already says "collection".
 */
export function collectionName(title: string): string {
  const parts = title.split(/\s+[-|–]\s+/);
  const name = parts.length >= 3 ? (parts.find((s) => seasonIn(s) || holidaysIn(s).length) ?? title) : title;
  return name.replace(/\s+collection$/i, '').trim();
}

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
    .map((c) => ({ handle: c.handle, title: collectionName(c.title), season: seasonIn(c.title), holidays: holidaysIn(c.title) }))
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

export type SkippedProduct = { shopifyId: number; title: string; reason: string };

export type PickResult = {
  picks: ProductPick[];
  ordered: RankedProduct[];
  skipped: SkippedProduct[];
  /** Every product that counts as seasonal today, with the words a marketer sees ("From your Fall Favorites collection"). */
  seasonalLabels: Map<number, string>;
  /** The family the picks came from, and why ("Coffee, named in your brand description"). */
  core: Core | null;
};

/** "Oct 8": dates in pick reasons read like a person wrote them. */
// The date as the store wrote it: published_at carries the store's offset ("2026-10-08T21:00:00-04:00"),
// so converting to UTC would show the next day.
const shortDate = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const isClearance = (p: SlimProduct) => p.tags.includes('last call') || /last call|final sale|clearance/i.test(p.title);
const themeOf = (p: SlimProduct) => holidaysIn(`${p.title} ${p.tags.join(' ')}`);

// "Cocoa Checkered" and "Caramel Checkered" would make two near-identical ads, so a pick
// that shares a title word (plural-insensitive) with an earlier pick is passed over. Words in
// at least 15% of the pool's titles don't count: every Gymshark title says "Gymshark" and every
// Allbirds one "Men's" or "Women's", which made all their products look alike.
function commonWords(pool: SlimProduct[]): Set<string> {
  const seen = new Map<string, number>();
  for (const p of pool) for (const w of words(p.title)) seen.set(w, (seen.get(w) ?? 0) + 1);
  // Small pools need a word in half the titles ("Sheet" on Brooklinen's 18), so two Loopy-sized
  // designs that share "Dots" still count as alike.
  const share = pool.length >= 20 ? 0.15 : 0.5;
  return new Set(pool.length >= 8 ? [...seen].filter(([, n]) => n / pool.length >= share).map(([w]) => w) : []);
}
function looksAlike(a: SlimProduct, b: SlimProduct, common: Set<string>): boolean {
  const wb = words(b.title);
  return [...words(a.title)].some((w) => !common.has(w) && wb.has(w));
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
  opts: { today: Date; collections?: SeasonalCollection[]; pinnedHandle?: string | null; brandText?: string },
): PickResult {
  const core = coreFamily(products, opts.brandText);
  const ranked = rankProducts(products, { core: core?.family ?? null, pinnedHandle: opts.pinnedHandle });
  const inCore = (p: SlimProduct) => !core || typeFamily(p.productType) === core.family;
  const common = commonWords(ranked.filter((p) => inCore(p) && productKind(p) === 'product'));
  const collections = opts.collections ?? [];
  const skipped: PickResult['skipped'] = [];

  const eligible = ranked.filter((p) => {
    const late = themeOf(p).find((h) => holidayTooClose(h, opts.today));
    if (late && p.handle !== opts.pinnedHandle) {
      const days = daysUntil(late, opts.today);
      skipped.push({
        shopifyId: p.shopifyId,
        title: p.title,
        reason: `${late.name} is ${days} day${days === 1 ? '' : 's'} away, too close to ramp up a campaign (we need ${MIN_HOLIDAY_LEAD_DAYS}+)`,
      });
      return false;
    }
    return true;
  });
  const fresh = eligible.filter((p) => !isClearance(p));
  // The named slots only use single products from the core range; other products, merch and
  // bundles only fill a slot nothing else can (ranked's order already puts them last).
  // Season fit: a summer product never fills a slot in fall or winter unless nothing else can.
  const misfit = (p: SlimProduct) => (p.handle === opts.pinnedHandle ? null : offSeason(`${p.title} ${cleanType(p.productType)} ${p.tags.join(' ')}`, opts.today));
  const core1 = fresh.filter((p) => inCore(p) && productKind(p) === 'product' && !misfit(p));
  // The best few it passed over are listed on the review card, with "Use anyway".
  for (const p of fresh.filter((x) => inCore(x) && productKind(x) === 'product' && misfit(x)).slice(0, 3)) {
    skipped.push({ shopifyId: p.shopifyId, title: p.title, reason: misfit(p)! });
  }

  const picks: ProductPick[] = [];
  const take = (
    cands: readonly RankedProduct[],
    slot: Slot,
    reason: (p: RankedProduct) => string,
    seasonal?: (p: RankedProduct) => ProductPick['seasonal'],
    allowAlike = false,
  ) => {
    if (picks.length >= 3) return;
    // One seasonal pick: a store with several seasonal collections (Allbirds) filled two slots.
    if (slot === 'seasonal' && picks.some((x) => x.slot === 'seasonal')) return;
    const p = cands.find((c) => !picks.some((x) => x.shopifyId === c.shopifyId || (!allowAlike && looksAlike(x, c, common))));
    if (p) picks.push({ ...p, slot, pickReason: reason(p), seasonal: seasonal?.(p) });
  };
  const byNewest = (list: RankedProduct[]) =>
    [...list].sort((a, b) => Number(heroCount(b) >= 3) - Number(heroCount(a) >= 3) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

  const pinned = eligible.find((p) => p.handle === opts.pinnedHandle);
  if (pinned) picks.push({ ...pinned, slot: 'pinned', pickReason: 'The product you linked' });

  // Reasons are written for the marketer, not as database fields.
  const bestSellers = signalTags(core1).has('best seller') ? core1.filter((p) => p.tags.includes('best seller')) : [];
  take(bestSellers, 'best_seller', () => (bestSellers.length === 1 ? 'Your best seller' : `One of your ${bestSellers.length} best sellers`));

  take(byNewest(core1), 'newest', (p) => `Your newest drop (${shortDate(p.publishedAt)})`);

  // Seasonal: the current season's collection first ("prefer the fall collection"), then a
  // collection or product theme for a holiday 14-60 days out.
  const season = currentSeason(opts.today);
  for (const c of collections.filter((c) => c.season === season)) {
    take(
      byNewest(core1.filter((p) => c.productIds.has(p.shopifyId))),
      'seasonal',
      () => `From your ${c.title} collection`,
      () => ({ season }),
    );
  }
  for (const c of collections.filter((c) => c.holidays.some((h) => holidayInWindow(h, opts.today)))) {
    const h = c.holidays.find((x) => holidayInWindow(x, opts.today))!;
    take(
      byNewest(core1.filter((p) => c.productIds.has(p.shopifyId))),
      'seasonal',
      () => `From your ${c.title} collection, for ${h.name} in ${daysUntil(h, opts.today)} days`,
      () => ({ holiday: h }),
    );
  }
  take(
    byNewest(core1.filter((p) => themeOf(p).some((h) => holidayInWindow(h, opts.today)))),
    'seasonal',
    (p) => {
      const h = themeOf(p).find((x) => holidayInWindow(x, opts.today))!;
      return `A ${h.name} design, ${daysUntil(h, opts.today)} days out`;
    },
    (p) => ({ holiday: themeOf(p).find((x) => holidayInWindow(x, opts.today)) }),
  );

  // Any slot still empty takes the next core product by rank, then a core product even if it
  // looks like a pick (a second coffee beats a T-shirt for a coffee brand), and only then
  // anything else by rank: other products, merch, bundles, clearance last.
  const nextBest = (p: RankedProduct) =>
    isClearance(p) ? 'Clearance stock, the best left to feature' : inCore(p) ? 'One of your top-ranked products' : 'Outside your core range: not enough core products to fill this slot';
  for (const [cands, alike] of [
    [core1, false],
    [core1, true],
    [[...fresh.filter((p) => !misfit(p)), ...fresh.filter((p) => misfit(p)), ...eligible.filter(isClearance)], false],
  ] as const)
    for (let i = 0; i < 2; i++) take(cands, 'next_best', nextBest, undefined, alike);

  // The same seasonal test, applied to the whole catalog, so a product swapped in on the review
  // card can re-suggest the goal. Holiday-skipped products keep their season: the marketer can
  // still choose to use one.
  const seasonalLabels = new Map<number, string>();
  for (const p of ranked.filter((x) => !isClearance(x))) {
    const inSeason = collections.find((c) => c.season === season && c.productIds.has(p.shopifyId));
    const holidayCol = collections.find((c) => c.productIds.has(p.shopifyId) && c.holidays.some((h) => holidayInWindow(h, opts.today)));
    const theme = themeOf(p).find((h) => holidayInWindow(h, opts.today));
    const label = inSeason ? `From your ${inSeason.title} collection` : holidayCol ? `From your ${holidayCol.title} collection` : theme ? `A ${theme.name} design` : null;
    if (label) seasonalLabels.set(p.shopifyId, label);
  }

  const pickIds = new Set(picks.map((p) => p.shopifyId));
  const ordered = [...picks, ...ranked.filter((p) => !pickIds.has(p.shopifyId))].map((p, i) => ({
    ...p,
    rank: i + 1,
    rankReason: 'pickReason' in p ? (p as ProductPick).pickReason : p.rankReason,
  }));
  return { picks: picks.map((p, i) => ({ ...p, rank: i + 1, rankReason: p.pickReason })), ordered, skipped, seasonalLabels, core };
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
