import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyProblem, sentenceCaseProblem } from './copy';

const product: { title: string; price: number; compareAtPrice: number | null; description: string } = { title: 'Night Sky', price: 42.99, compareAtPrice: null, description: '' };
const claims = ['70,000+ five star reviews', 'over 93% of people in-the-Loop would recommend Loopy to a friend'];
const ok = (headline: string, cta = 'Shop Now', citedClaim: string | null = null, angle: 'social_proof' | 'aesthetic' | 'offer' = 'social_proof', p = product) =>
  copyProblem({ headline, cta, citedClaim }, { angle, claims, product: p });

test('copy that states nothing, or cites what it states, passes', () => {
  assert.equal(ok('Stargazing, in your hand', 'Shop Now', null, 'aesthetic'), null);
  assert.equal(ok('Join 70,000+ five star reviews', 'See Why', claims[0]), null);
});

test('numbers must come from the cited claim, or a real price on an offer', () => {
  assert.match(ok('Loved by 80,000+ fans', 'Shop Now', claims[0])!, /80,000\+/);
  assert.match(ok('93% would recommend us')!, /93%/);
  assert.equal(ok('Now $35.99', 'Shop Now', null, 'offer', { ...product, price: 35.99, compareAtPrice: 42.99 }), null);
  assert.match(ok('Now $29.99', 'Shop Now', null, 'offer', { ...product, price: 35.99, compareAtPrice: 42.99 })!, /29\.99/);
});

test('trigger words need a cited claim that says them', () => {
  assert.match(ok('Lifetime warranty, zero worries', 'Shop Now', null, 'aesthetic')!, /needs a cited claim/);
  assert.match(ok('Rated best by everyone', 'Shop Now', claims[0])!, /"rated" needs a cited claim/);
});

test('a discount without a real compare_at_price is refused, and lengths are capped', () => {
  assert.match(ok('Fall sale on Night Sky', 'Shop Now', null, 'aesthetic')!, /discount/);
  assert.match(ok('One two three four five six seven')!, /7 words/);
  assert.match(ok('Short', 'Tap here right now')!, /CTA/);
  assert.match(ok('Trusted by many', 'Shop Now', 'made up claim')!, /not one of the approved claims/);
});

test('a compound claim word must be used whole: risk-free is not free', () => {
  const trial = ['Risk-Free 30 Day Trial'];
  const check = (headline: string, cta: string) => copyProblem({ headline, cta, citedClaim: trial[0] }, { angle: 'social_proof', claims: trial, product });
  assert.match(check('Try Loopy Free for 30 Days', 'Try It Free')!, /"risk-free"/);
  assert.equal(check('Risk-Free 30 Day Trial', 'Try It'), null);
});

test('punctuation after a number is not part of it', () => {
  const track = ['Trusted since 2012'];
  assert.equal(copyProblem({ headline: 'Since 2012, still looping', cta: 'Shop Now', citedClaim: track[0] }, { angle: 'social_proof', claims: track, product }), null);
});

test('headlines are sentence case, but names keep their capitals', () => {
  const allowed = ['Loopy', 'Raspberry Dots', '30 Day Money-Back Guarantee'];
  assert.match(sentenceCaseProblem('Love the Dots, or Money Back', ['Loopy', 'Night Sky', ''])!, /"Dots"/);
  assert.equal(sentenceCaseProblem('Raspberry Dots, extra grip included', allowed), null);
  assert.equal(sentenceCaseProblem('Try Loopy risk-free for 30 days', allowed), null);
  assert.equal(sentenceCaseProblem('Night Sky: Stargazing every season', ['Night Sky']), null);
  assert.match(sentenceCaseProblem('Grip Like You Mean It', [])!, /"Like"/);
});
