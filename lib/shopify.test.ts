import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterTags,
  parseStoreUrl,
  pickMix,
  pickSourceImage,
  rankProducts,
  coreFamily,
  productKind,
  cleanType,
  typeFamily,
  slimProduct,
  suggestGoal,
  type RawProduct,
  type SeasonalCollection,
  type SlimProduct,
} from './shopify';

// ── Tag filter ───────────────────────────────────────────────────────────────

test('filterTags drops Loopy internal tags and keeps shopper-facing ones', () => {
  // Real tags from loopycases.com/products.json.
  const tags = [
    'Contains i13/i12 6.7 UNI',
    'contains i11/i10 6.1 UNI',
    'contains i16',
    'Contains i12 5.4',
    'pf-plp-exp',
    'testpromo',
    'auto-select:off',
    'pc-glbe-giftcard',
    'is-apple',
    'LTE',
    'best seller',
    'last call',
    'new',
    'limited',
    'super loops',
    'Leather-feel-onyx',
    'halloween',
  ];
  assert.deepEqual(filterTags(tags), ['best seller', 'last call', 'new', 'limited', 'super loops', 'leather-feel-onyx', 'halloween']);
});

test('filterTags accepts the comma-separated string from /products/<handle>.json and dedupes', () => {
  assert.deepEqual(filterTags('New, Contains i16, new ,  limited'), ['new', 'limited']);
});

test('filterTags drops device codes and screen sizes', () => {
  assert.deepEqual(filterTags(['i13', 'S24 Ultra', '6.1', 'iPhone 16 6.3', 'gift card']), ['gift card']);
});

// ── URL normalization ────────────────────────────────────────────────────────

test('parseStoreUrl handles bare domains, www and product URLs', () => {
  assert.deepEqual(parseStoreUrl('loopycases.com'), { origin: 'https://loopycases.com', domain: 'loopycases.com', productHandle: null });
  assert.deepEqual(parseStoreUrl(' https://www.LoopyCases.com/collections/all '), {
    origin: 'https://www.loopycases.com',
    domain: 'loopycases.com',
    productHandle: null,
  });
  assert.equal(parseStoreUrl('https://loopycases.com/products/black-bows?variant=1').productHandle, 'black-bows');
  assert.equal(parseStoreUrl('loopycases.com/collections/cases/products/lavender-pearl').productHandle, 'lavender-pearl');
});

// ── Ranking ──────────────────────────────────────────────────────────────────

let nextId = 1;
function product(over: Partial<SlimProduct> & { title: string }): SlimProduct {
  const heroes = (over as { heroes?: number }).heroes ?? 3;
  return {
    shopifyId: nextId++,
    handle: over.title.toLowerCase().replace(/\s+/g, '-'),
    productType: 'cases',
    tags: [],
    price: 39.99,
    compareAtPrice: null,
    available: true,
    description: '',
    images: Array.from({ length: heroes }, (_, i) => ({ id: i, src: `https://cdn/x${i}.jpg`, position: i + 1, isHero: true })),
    publishedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

test('rankProducts orders best seller > new > limited > rest, with last call at the bottom', () => {
  const ranked = rankProducts([
    product({ title: 'Plain' }),
    product({ title: 'Clearance', tags: ['last call'] }),
    product({ title: 'Limited One', tags: ['limited'] }),
    product({ title: 'Fresh', tags: ['new'] }),
    product({ title: 'Hit', tags: ['best seller'] }),
    product({ title: 'Old Hit', tags: ['best seller', 'last call'] }),
  ]);
  assert.deepEqual(
    ranked.map((p) => p.title),
    ['Hit', 'Fresh', 'Limited One', 'Plain', 'Old Hit', 'Clearance'],
  );
  assert.deepEqual(
    ranked.map((p) => p.rank),
    [1, 2, 3, 4, 5, 6],
  );
});

test('rankProducts breaks ties on 3+ hero images, then recency', () => {
  const ranked = rankProducts([
    product({ title: 'Old', publishedAt: '2025-01-01T00:00:00Z' }),
    product({ title: 'Few Photos', publishedAt: '2026-06-01T00:00:00Z', heroes: 2 } as Partial<SlimProduct> & { title: string }),
    product({ title: 'Recent', publishedAt: '2026-05-01T00:00:00Z' }),
  ]);
  assert.deepEqual(
    ranked.map((p) => p.title),
    ['Recent', 'Old', 'Few Photos'],
  );
});

test('rankProducts drops unavailable products and ranks other types below the core one', () => {
  const ranked = rankProducts([
    product({ title: 'Case A' }),
    product({ title: 'Case B' }),
    product({ title: 'Sold Out', tags: ['best seller'], available: false }),
    product({ title: 'Loop', productType: 'Loops', tags: ['best seller'] }),
  ]);
  assert.deepEqual(ranked.map((p) => p.title), ['Case A', 'Case B', 'Loop']);
  assert.match(ranked[2].rankReason, /^outside your core range/);
});

// ── Multi-category stores (Death Wish Coffee, Brooklinen, Gymshark, Allbirds; 2026-11-04) ──

test('the core range comes from the brand text, not the largest type: coffee beats apparel', () => {
  const store = [
    ...Array.from({ length: 6 }, (_, i) => product({ title: `Tee ${i}`, productType: 'Apparel', tags: ['best seller'] })),
    ...Array.from({ length: 5 }, (_, i) => product({ title: `Roast ${i}`, productType: 'Coffee' })),
    product({ title: 'Mug', productType: 'Mugs' }),
  ];
  assert.equal(coreFamily(store, "The world's strongest coffee")?.label, 'Coffee');
  // Without a brand match, the largest non-merch family still wins over apparel.
  assert.equal(coreFamily(store, '')?.label, 'Coffee');
  const { picks } = pickMix(store, { today: TODAY, brandText: "The world's strongest coffee" });
  assert.ok(picks.every((p) => p.productType === 'Coffee'), picks.map((p) => p.title).join());
});

test('bundles and non-products are skipped while single products exist', () => {
  assert.equal(productKind({ productType: 'Content', title: 'Sleep guide', price: 0 }), 'non_product');
  assert.equal(productKind({ productType: 'Gift Card', title: 'Gift Card', price: 25 }), 'non_product');
  assert.equal(productKind({ productType: 'Sheets', title: 'Luxe Sateen Hardcore Bundle', price: 606 }), 'bundle');
  assert.equal(productKind({ productType: 'Sheets', title: 'Essential Sheet Set', price: 149 }), 'product');
  const store = [
    ...Array.from({ length: 8 }, (_, i) => product({ title: `Bundle ${i}`, productType: 'Bundle', tags: ['best seller'] })),
    ...Array.from({ length: 4 }, (_, i) => product({ title: `Sheet ${['Linen', 'Sateen', 'Percale', 'Flannel'][i]}`, productType: 'Sheets' })),
    product({ title: 'How we source', productType: 'Content', price: 0 }),
  ];
  const { picks } = pickMix(store, { today: TODAY });
  assert.equal(picks.length, 3);
  assert.ok(picks.every((p) => p.productType === 'Sheets'));
});

test('path-style types use their meaningful segments', () => {
  assert.equal(cleanType('Womens>Apparel>Leggings>full_length'), 'Leggings');
  assert.equal(typeFamily('Mens>Apparel>SS Tops>t_shirt'), 'apparel');
  assert.equal(typeFamily('Cases'), 'cases');
});

test('a word every title shares (the brand, "Men\'s") does not make products look alike', () => {
  const titles = Array.from({ length: 24 }, (_, i) => `Gymshark ${['Vital', 'Apex', 'Crest', 'Arrival', 'Legacy', 'Power'][i % 6]} ${['Leggings', 'Shorts', 'Tank', 'Hoodie'][i % 4]} ${i}`);
  const store = titles.map((t, i) => product({ title: t, productType: 'Womens>Apparel>Leggings>full_length', publishedAt: `2026-0${1 + (i % 9)}-01T00:00:00Z` }));
  assert.equal(pickMix(store, { today: TODAY }).picks.length, 3);
});

test('warehouse and system tags are filtered, and merchandising synonyms are normalized', () => {
  assert.deepEqual(
    filterTags(['wc wave 1 truck #1-#16 7.30.2026', '11/3/26 drop', 'gcxu5198421 (pl 555111127599)', 'oos dns', 'ec stock', 'yblocklist', 'ygroup_ygroup_mens', 'feedonomics-include', 'bundle_product|1|all', 'yellow', 'Most-Loved', 'new-releases', 'NewArrivals']),
    ['yellow', 'best seller', 'new'],
  );
});

test('rankProducts puts a pinned product first, even from another type', () => {
  const ranked = rankProducts(
    [product({ title: 'Hit', tags: ['best seller'] }), product({ title: 'Cases', tags: [] }), product({ title: 'My Loop', productType: 'Loops' })],
    { pinnedHandle: 'my-loop' },
  );
  assert.equal(ranked[0].title, 'My Loop');
  assert.match(ranked[0].rankReason, /the product you linked/);
});

test('rankReason explains the pick in words', () => {
  const [p] = rankProducts([product({ title: 'Hit', tags: ['best seller'], publishedAt: '2025-09-04T00:00:00Z', heroes: 7 } as Partial<SlimProduct> & { title: string })]);
  assert.equal(p.rankReason, 'tagged best seller, 7 lifestyle photos, published 2025-09-04');
});

// ── Slimming, images, goal ───────────────────────────────────────────────────

const raw: RawProduct = {
  id: 42,
  handle: 'black-bows',
  title: 'Black Bows',
  body_html: '<p>Cute &amp; <b>secure</b></p>',
  product_type: 'cases',
  tags: ['best seller', 'Contains i16'],
  published_at: '2024-11-26T00:00:00Z',
  variants: [
    { price: '42.99', compare_at_price: '50.00', available: false },
    { price: '39.99', compare_at_price: '39.99', available: true },
  ],
  images: [
    { id: 2, src: 'https://cdn/cutout.gif?v=1', position: 2, variant_ids: [7] },
    { id: 1, src: 'https://cdn/anim.gif?v=1', position: 1, variant_ids: [] },
    { id: 3, src: 'https://cdn/hand.jpg?v=1', position: 3, variant_ids: [] },
  ],
};

test('slimProduct prices from the cheapest available variant and ignores fake discounts', () => {
  const p = slimProduct(raw);
  assert.equal(p.price, 39.99);
  assert.equal(p.compareAtPrice, null); // compare_at equal to price is not a discount
  assert.deepEqual(p.tags, ['best seller']);
  assert.equal(p.description, 'Cute & secure');
});

test('pickSourceImage prefers a still hero over position 1 when position 1 is a GIF', () => {
  assert.equal(pickSourceImage(slimProduct(raw))?.id, 3);
});

// ── The 3-pick mix and the goal (shaped like Loopy on 2026-10-27) ─────────────

const TODAY = new Date('2026-10-27T12:00:00Z'); // Halloween 4 days out, Christmas 59
const hit = (title: string, publishedAt: string, extra: Partial<SlimProduct> = {}) =>
  product({ title, tags: ['best seller'], publishedAt, heroes: 7, ...extra } as Partial<SlimProduct> & { title: string });
const drop = (title: string, publishedAt: string, tags = ['new'], extra: Partial<SlimProduct> = {}) =>
  product({ title, tags, publishedAt, heroes: 7, ...extra } as Partial<SlimProduct> & { title: string });

function loopyLike() {
  const items = {
    cocoa: hit('Cocoa Checkered', '2025-09-04T00:00:00Z'),
    red: hit('Red', '2025-05-21T00:00:00Z'),
    raspberry: drop('Raspberry Dots', '2026-10-08T00:00:00Z'),
    java: drop('Java Dots', '2026-10-08T00:00:00Z'),
    nightSky: drop('Night Sky', '2026-09-24T00:00:00Z'),
    boo: drop('Boo Crew', '2026-10-20T00:00:00Z', ['limited']), // newest of all, but Halloween
    clearance: drop('Old Favorite', '2026-10-25T00:00:00Z', ['last call'], { compareAtPrice: 59.99 }),
  };
  const fall: SeasonalCollection = {
    handle: 'fall-collection',
    title: 'Fall Favorites',
    season: 'fall',
    holidays: [],
    productIds: new Set([items.raspberry, items.java, items.nightSky, items.boo].map((p) => p.shopifyId)),
  };
  return { items, all: Object.values(items), collections: [fall] };
}

test('pickMix picks one best seller, one newest and one seasonal product', () => {
  const { all, collections } = loopyLike();
  const { picks } = pickMix(all, { today: TODAY, collections });
  assert.deepEqual(
    picks.map((p) => [p.slot, p.title]),
    [
      ['best_seller', 'Cocoa Checkered'],
      ['newest', 'Raspberry Dots'],
      // Java Dots is newer but looks like Raspberry Dots, so the next fall product wins.
      ['seasonal', 'Night Sky'],
    ],
  );
  // Reasons read like a marketer wrote them, not like database fields.
  assert.deepEqual(
    picks.map((p) => p.pickReason),
    ['One of your 2 best sellers', 'Your newest drop (Oct 8)', 'From your Fall Favorites collection'],
  );
});

test('pickMix skips products themed on a holiday under 14 days away, and says why', () => {
  const { all, collections } = loopyLike();
  const { picks, skipped } = pickMix(all, { today: TODAY, collections });
  assert.ok(!picks.some((p) => p.title === 'Boo Crew'));
  assert.deepEqual(
    skipped.map(({ title, reason }) => ({ title, reason })),
    [{ title: 'Boo Crew', reason: 'Halloween is 4 days away, too close to ramp up a campaign (we need 14+)' }],
  );
  // Six weeks earlier, the same product is fair game.
  const early = pickMix(all, { today: new Date('2026-09-15T12:00:00Z'), collections });
  assert.deepEqual(early.skipped, []);
});

test('pickMix never leads with clearance, even when it is the newest and on sale', () => {
  const { all, collections } = loopyLike();
  const { picks, ordered } = pickMix(all, { today: TODAY, collections });
  assert.ok(!picks.some((p) => p.tags.includes('last call')));
  assert.deepEqual(
    ordered.slice(0, 3).map((p) => p.rank),
    [1, 2, 3],
  );
});

test('pickMix falls back to a holiday collection 14-60 days out when no season collection fits', () => {
  const { items } = loopyLike();
  const xmas: SeasonalCollection = {
    handle: 'holiday-neutral-tones',
    title: 'Holiday | Neutral Tones',
    season: null,
    holidays: [{ key: 'christmas', name: 'Christmas', month: 12, day: 25 }],
    productIds: new Set([items.java.shopifyId, items.nightSky.shopifyId]),
  };
  const { picks } = pickMix([items.cocoa, items.raspberry, items.java, items.nightSky], { today: TODAY, collections: [xmas] });
  assert.equal(picks[2].slot, 'seasonal');
  assert.equal(picks[2].pickReason, 'From your Holiday | Neutral Tones collection, for Christmas in 59 days');
});

test('pickMix keeps a pinned product first', () => {
  const { all, collections } = loopyLike();
  const { picks } = pickMix(all, { today: TODAY, collections, pinnedHandle: 'red' });
  assert.deepEqual(
    picks.map((p) => p.slot),
    ['pinned', 'best_seller', 'newest'],
  );
});

test('suggestGoal: seasonal with an in-season pick, sale only for non-clearance discounts, else evergreen', () => {
  const { all, collections, items } = loopyLike();
  assert.equal(suggestGoal(pickMix(all, { today: TODAY, collections }).picks), 'seasonal');

  const noSeason = pickMix([items.cocoa, items.red, items.raspberry], { today: TODAY }).picks;
  assert.equal(suggestGoal(noSeason), 'evergreen');

  const discounted = pickMix([items.cocoa, drop('Deal', '2026-10-01T00:00:00Z', ['new'], { compareAtPrice: 49.99 })], { today: TODAY }).picks;
  assert.equal(suggestGoal(discounted), 'sale');

  // Clearance is only picked when nothing else is left, and its discount never makes it a sale.
  const onlyClearance = pickMix([items.clearance], { today: TODAY }).picks;
  assert.equal(onlyClearance[0].title, 'Old Favorite');
  assert.equal(suggestGoal(onlyClearance), 'evergreen');
});

test('pickMix labels every seasonal product, so a swap can re-suggest the goal', () => {
  const { all, collections, items } = loopyLike();
  const { seasonalLabels } = pickMix(all, { today: TODAY, collections });
  assert.equal(seasonalLabels.get(items.nightSky.shopifyId), 'From your Fall Favorites collection');
  assert.equal(seasonalLabels.get(items.cocoa.shopifyId), undefined);
});

test('Gymshark: "workout clothes and accessories" means apparel, not the much smaller accessories range', () => {
  const store = [
    ...Array.from({ length: 30 }, (_, i) => product({ title: `Legging ${i}`, productType: 'Womens>Apparel>Leggings>full_length' })),
    ...Array.from({ length: 2 }, (_, i) => product({ title: `Keyring ${i}`, productType: 'Accessories>Keyrings' })),
  ];
  assert.equal(coreFamily(store, 'performance workout clothes and accessories')?.label, 'Apparel');
});

test('a merchandising tag on nearly every product is not a signal ("One of your 2685 best sellers")', () => {
  const store = Array.from({ length: 30 }, (_, i) => product({ title: `Item ${String.fromCharCode(65 + i)}${i}`, tags: ['best seller'], publishedAt: `2026-0${1 + (i % 9)}-01T00:00:00Z` }));
  const { picks } = pickMix(store, { today: TODAY });
  assert.ok(!picks.some((p) => p.slot === 'best_seller'));
});

test('season fit: summer products are left out of a November round, and the review card says why', () => {
  const nov = new Date('2026-11-04T12:00:00Z');
  const store = [
    product({ title: 'Flip Flop - Dusty Pink', productType: 'Shoes', publishedAt: '2026-11-01T00:00:00Z' }),
    product({ title: 'Tree Runner', productType: 'Shoes' }),
    product({ title: 'Wool Lounger', productType: 'Shoes' }),
    product({ title: 'Cruiser', productType: 'Shoes' }),
  ];
  const { picks, skipped } = pickMix(store, { today: nov });
  assert.ok(!picks.some((p) => p.title.startsWith('Flip Flop')));
  assert.deepEqual(skipped.map((s) => s.reason), ["a warm-weather product, and it's fall"]);
  // In July the same product is fair game.
  assert.ok(pickMix(store, { today: new Date('2026-07-01T12:00:00Z') }).picks.some((p) => p.title.startsWith('Flip Flop')));
});
