import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRound, SCENES } from './angles';

const LOOPY_TOPICS = ['track-record', 'reviews', 'returns', 'warranty', 'core-benefit'];
// Loopy on 2026-10-27: all three picks sit in a seasonal collection, as on the real store.
const picks = [
  { id: 'cocoa', hasDiscount: false, seasonal: true, bestSeller: true },
  { id: 'raspberry', hasDiscount: false, seasonal: true },
  { id: 'nightsky', hasDiscount: false, seasonal: true },
];

test('planRound gives each product 2 different angles, 6 ads in all', () => {
  const plan = planRound(picks, 'seasonal', LOOPY_TOPICS);
  assert.equal(plan.length, 6);
  for (const id of ['cocoa', 'raspberry', 'nightsky']) {
    const angles = plan.filter((a) => a.productId === id).map((a) => a.angle);
    assert.equal(new Set(angles).size, 2, id);
  }
});

test('planRound never repeats a setting within a round', () => {
  for (const goal of ['seasonal', 'sale', 'launch', 'evergreen'] as const) {
    const plan = planRound(picks, goal, LOOPY_TOPICS);
    const settings = plan.map((a) => `${a.angle}#${a.scene}`);
    assert.equal(new Set(settings).size, settings.length, goal);
    for (const a of plan) assert.ok(a.scene < SCENES[a.angle].length);
  }
});

test('planRound leads a best seller with social proof and spreads angles even when every pick is seasonal', () => {
  const plan = planRound(picks, 'seasonal', LOOPY_TOPICS);
  const of = (id: string) => plan.filter((a) => a.productId === id).map((a) => a.angle);
  assert.deepEqual(of('cocoa'), ['social_proof', 'aesthetic']);
  assert.ok(new Set(plan.map((a) => a.angle)).size >= 4, JSON.stringify(plan.map((a) => a.angle)));
  for (const angle of new Set(plan.map((a) => a.angle))) assert.ok(plan.filter((a) => a.angle === angle).length <= 2, angle);
});

test('offer only with a real discount; proof angles only with a matching claim', () => {
  const noClaims = planRound(picks, 'evergreen', []);
  assert.ok(noClaims.every((a) => a.angle !== 'social_proof' && a.angle !== 'guarantee' && a.angle !== 'offer'));
  const sale = planRound([{ id: 'deal', hasDiscount: true, seasonal: false }, ...picks.slice(1)], 'sale', LOOPY_TOPICS);
  assert.deepEqual(
    sale.filter((a) => a.angle === 'offer').map((a) => a.productId),
    ['deal'],
  );
});

test('planRound spreads claim topics so two ads lean on different facts while topics remain', () => {
  const plan = planRound(picks, 'evergreen', LOOPY_TOPICS);
  const proof = plan.filter((a) => a.angle === 'social_proof' || a.angle === 'guarantee').map((a) => a.claimTopic);
  assert.equal(new Set(proof).size, proof.length);
});
