import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRECRAWL_TTL_MS, groupClaims, isFreshFirecrawl, markdownToText, normalizeForMatch, parseHomepage, shortBrandName, validateClaims } from './brand';

// Loopy's real meta description, the main source of its claims.
const SITE =
  'Trusted since 2012, Loopy® has 70,000+ five star reviews, risk-free returns, and a lifetime warranty! ' +
  'Tired of dropping your phone? Loopy® has a comfy finger loop that prevents drops, increases grip and reach.';

test('validateClaims keeps claims found verbatim on the site', () => {
  const { kept, rejected } = validateClaims(['Trusted since 2012', '70,000+ five star reviews', 'lifetime warranty'], SITE);
  assert.deepEqual(kept, ['Trusted since 2012', '70,000+ five star reviews', 'lifetime warranty']);
  assert.deepEqual(rejected, []);
});

test('validateClaims rejects paraphrases, inflated numbers and invented claims', () => {
  const { kept, rejected } = validateClaims(
    ['70,000+ 5-star reviews', '100,000+ five star reviews', 'Free shipping on all orders', 'lifetime guarantee', 'warranty for life'],
    SITE,
  );
  assert.deepEqual(kept, []);
  assert.deepEqual(
    rejected.map((r) => r.reason),
    ['not_verbatim', 'not_verbatim', 'not_verbatim', 'not_verbatim', 'not_verbatim'],
  );
});

test('validateClaims ignores case, whitespace, trademark symbols, curly quotes and a trailing period', () => {
  const { kept } = validateClaims(['LOOPY has 70,000+  five star reviews.', 'Loopy® has a comfy finger loop'], SITE);
  assert.deepEqual(kept, ['LOOPY has 70,000+ five star reviews', 'Loopy® has a comfy finger loop']);
  assert.equal(normalizeForMatch('It’s Loopy™'), "it's loopy");
});

test('validateClaims drops duplicates and fragments too short to mean anything', () => {
  const { kept, rejected } = validateClaims(['lifetime warranty', 'Lifetime Warranty', 'and'], SITE);
  assert.deepEqual(kept, ['lifetime warranty']);
  assert.deepEqual(rejected, [{ claim: 'and', reason: 'too_short' }]);
});

test('parseHomepage reads meta, JSON-LD logo and the header logo, never the favicon', () => {
  const html = `<html><head><title>Loopy® | Grip Cases</title>
    <link rel="icon" href="/favicon.png">
    <meta content="Trusted since 2012" name="description">
    <meta property="og:image" content="https://cdn/shopify_logo_dark.png">
    <script type="application/ld+json">{"@type":"Organization","name":"Loopy®Cases","logo":"https://cdn/logo_pink.png","sameAs":["https://instagram.com/loopycases"]}</script>
    </head><body><header><img src="//www.loopycases.com/cdn/shop/files/logo_pink.png?height=160&amp;v=1"></header>
    <script>var hidden = "not text";</script><p>Get in the Loop&trade; today</p></body></html>`;
  const home = parseHomepage(html, 'https://www.loopycases.com');
  assert.equal(home.title, 'Loopy® | Grip Cases');
  assert.equal(home.description, 'Trusted since 2012');
  assert.equal(home.jsonLd.logo, 'https://cdn/logo_pink.png');
  assert.deepEqual(home.jsonLd.sameAs, ['https://instagram.com/loopycases']);
  assert.equal(home.headerLogo, 'https://www.loopycases.com/cdn/shop/files/logo_pink.png?height=160&v=1');
  assert.ok(!home.text.includes('not text'));
});

test('isFreshFirecrawl reuses only successful scrapes younger than the TTL', () => {
  const now = Date.parse('2026-10-27T00:00:00Z');
  const ok = { status: 'ok', markdown: '# Loopy', fetchedAt: '2026-10-26T00:00:00Z' };
  assert.equal(isFreshFirecrawl(ok, now), true);
  assert.equal(isFreshFirecrawl({ ...ok, fetchedAt: new Date(now - FIRECRAWL_TTL_MS - 1).toISOString() }, now), false);
  assert.equal(isFreshFirecrawl({ ...ok, status: 'failed' }, now), false); // failures are retried, not cached
  assert.equal(isFreshFirecrawl({ ...ok, markdown: undefined }, now), false); // claims need the text
  assert.equal(isFreshFirecrawl(undefined, now), false);
});

// The cases below come from the first real run on loopycases.com (NOTES.md, M2).

// Excerpt of Loopy's Firecrawl markdown.
const MARKDOWN = `## 70,000+ Five-Star Reviews
**FREE** US Ground Advantage shipping on orders $55+
Buy 2 Super Loops, Get 1 **FREE**
[30 Day Risk-Free Trial](https://www.loopycases.com/pages/trial)
Trusted since 2012, Loopy® has 70,000+ five star reviews, risk-free returns, and a lifetime warranty!`;

test('markdownToText strips formatting but keeps the words', () => {
  assert.equal(markdownToText('## Big **FREE** [trial](https://x.y/z) ![img](a.png)').trim(), 'Big FREE trial');
});

test('validateClaims treats a hyphenated duplicate as the same claim', () => {
  const { kept } = validateClaims(['70,000+ five star reviews', '70,000+ Five-Star Reviews'], MARKDOWN);
  assert.deepEqual(kept, ['70,000+ five star reviews']);
});

test('validateClaims rejects promotions even when they are verbatim', () => {
  const { kept, rejected } = validateClaims(['FREE** US Ground Advantage shipping on orders $55+', 'Buy 2 Super Loops, Get 1 **FREE**', '30 Day Risk-Free Trial'], MARKDOWN);
  assert.deepEqual(kept, ['30 Day Risk-Free Trial']);
  assert.deepEqual(rejected, [
    { claim: 'FREE US Ground Advantage shipping on orders $55+', reason: 'promotion' },
    { claim: 'Buy 2 Super Loops, Get 1 FREE', reason: 'promotion' },
  ]);
});

test('validateClaims drops a leading article', () => {
  assert.deepEqual(validateClaims(['a lifetime warranty'], MARKDOWN).kept, ['lifetime warranty']);
});

test('validateClaims keeps a percentage statistic and strips _emphasis_ underscores', () => {
  const site = 'over _93%_ of people in-the-Loop would recommend Loopy to a friend';
  assert.deepEqual(validateClaims(['over 93%_ of people in-the-Loop would recommend Loopy to a friend'], site).kept, [
    'over 93% of people in-the-Loop would recommend Loopy to a friend',
  ]);
  assert.equal(validateClaims(['20% off everything'], '20% off everything').rejected[0].reason, 'promotion');
  assert.equal(markdownToText('keep snake_case_words'), 'keep snake_case_words');
});

test('shortBrandName derives the name ads should use', () => {
  assert.equal(shortBrandName('Loopy®Cases'), 'Loopy');
  assert.equal(shortBrandName('Loopy® Cases'), 'Loopy');
  assert.equal(shortBrandName('Allbirds'), 'Allbirds');
  assert.equal(shortBrandName('Brooklinen | Luxury Bed Sheets'), 'Brooklinen');
  assert.equal(shortBrandName('Pura Vida Bracelets Shop'), 'Pura Vida Bracelets');
  assert.equal(shortBrandName('Case Co'), 'Case'); // never strips down to nothing
});

test('groupClaims puts near-duplicates under one topic, using the kept wording', () => {
  const labelled = [
    { text: 'a lifetime warranty', topic: 'warranty' },
    { text: 'Lifetime Loopy® Guarantee', topic: 'Warranty' },
    { text: 'risk-free returns', topic: 'returns' },
    { text: 'Risk-Free 30 Day Trial.', topic: 'returns' },
    { text: '70,000+ five star reviews', topic: 'reviews' },
    { text: 'Free shipping on orders $55+', topic: 'shipping' }, // rejected, so not grouped
  ];
  const kept = ['lifetime warranty', 'Lifetime Loopy® Guarantee', 'risk-free returns', 'Risk-Free 30 Day Trial', '70,000+ five star reviews'];
  assert.deepEqual(groupClaims(labelled, kept), [
    { topic: 'warranty', claims: ['lifetime warranty', 'Lifetime Loopy® Guarantee'] },
    { topic: 'returns', claims: ['risk-free returns', 'Risk-Free 30 Day Trial'] },
    { topic: 'reviews', claims: ['70,000+ five star reviews'] },
  ]);
});
