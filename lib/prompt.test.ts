import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basePrompt, buildPrompt, EDIT_PREFIX, editPrompt, REVISION_MARKER, revisedPrompt, sceneFor } from './prompt';
import { ANGLES, SCENES } from './angles';
import { fallbackProfile, MODES, type ProductProfile } from './profile';

const loopy: ProductProfile = {
  category: 'phone case',
  mode: 'held',
  use: "the phone held securely by the case's finger loop",
  setting: 'living room',
  features: ['deep navy matte finish with cream celestial line art', 'blue finger loop strap', 'raised camera cutout'],
  inUsePhoto: true,
};

const v1 = buildPrompt({
  brandName: 'Loopy',
  productTitle: 'Night Sky',
  product: loopy,
  angle: 'benefit',
  scene: 0,
  season: 'fall',
  colors: { primary: '#F990A8', text: '#2C2B23' },
  buttonInk: '#2C2B23',
  voiceAdjectives: ['playful'],
  headline: 'Grip like you mean it.',
  cta: 'Grab Yours',
  brandRules: ['Always show the finger loop'],
});

test('a revision keeps the base prompt and replaces rules and notes instead of piling them up', () => {
  const v2 = revisedPrompt(v1, { brandRules: ['Never use dark backgrounds'], revisionNotes: ['Use warmer, golden-hour lighting'], fromPrevious: true });
  assert.ok(v2.startsWith(basePrompt(v1)));
  assert.ok(v2.includes(REVISION_MARKER));
  assert.ok(v2.includes('- Never use dark backgrounds'));
  assert.ok(!v2.includes('Always show the finger loop'), 'a rule switched off since v1 must not linger');
  // v3 from v2: one REFERENCE section, both notes, oldest first.
  const v3 = revisedPrompt(v2, { brandRules: [], revisionNotes: ['Use warmer, golden-hour lighting', 'Show more of the loop'], fromPrevious: true });
  assert.equal(v3.split(REVISION_MARKER).length, 2);
  assert.ok(v3.indexOf('golden-hour') < v3.indexOf('more of the loop'));
});

test('a revision can change the copy in the base prompt', () => {
  const v2 = revisedPrompt(v1, { brandRules: [], revisionNotes: [], fromPrevious: false, headline: { from: 'Grip like you mean it.', to: 'Golden stars that stay in hand' } });
  assert.ok(v2.includes('"Golden stars that stay in hand"'));
  assert.ok(!v2.includes('Grip like you mean it.'));
});

test('a copy edit is marked as an edit and names both strings', () => {
  const e = editPrompt({ headline: 'Old line', cta: 'Shop Now' }, { headline: 'New line', cta: 'Get Yours' });
  assert.ok(e.startsWith(EDIT_PREFIX));
  assert.match(e, /"Old line" with "New line"/);
  assert.match(e, /Change nothing else/);
});

test('the prompt keeps text away from the edges', () => {
  assert.match(v1, /MARGINS — keep all text at least 8%/);
});

test('the fidelity section comes from the product profile, not a hard-coded phone case', () => {
  assert.match(v1, /The phone case "Night Sky" must keep its exact look:\n- deep navy matte finish/);
  assert.match(v1, /Keep the interaction from the photo: the phone held securely by the case's finger loop\./);
  const shoe = buildPrompt({
    ...{ brandName: 'Allbirds', productTitle: 'Tree Runner', angle: 'benefit', scene: 2, season: 'fall', colors: { primary: '#000', text: '#000' }, buttonInk: '#fff' },
    product: { category: 'running shoes', mode: 'worn', use: 'the sneakers worn by someone walking', setting: 'entryway', features: ['white knit upper', 'white sole', 'grey laces'], inUsePhoto: false },
    voiceAdjectives: ['calm'],
    headline: 'Walk lighter',
    cta: 'Shop Now',
  });
  assert.doesNotMatch(shoe, /phone|finger loop|camera cutout|case/i);
  assert.match(shoe, /Show it worn naturally/);
  assert.match(shoe, /SCENE — on a park path in soft daylight, the sneakers worn by someone walking, full-length framing/);
});

test('every scene resolves for every mode with no placeholder left over', () => {
  for (const angle of ANGLES)
    for (let i = 0; i < SCENES[angle].length; i++)
      for (const mode of MODES) {
        const s = sceneFor(angle, i, 'fall', { category: 'bag of coffee', mode, use: 'the coffee poured into a mug', setting: 'kitchen' });
        assert.doesNotMatch(s, /[{}]/, `${angle}#${i} ${mode}: ${s}`);
        assert.doesNotMatch(s, /\bcase\b|phone|loop/i, `${angle}#${i} ${mode}: ${s}`);
      }
});

test('without a profile the prompt falls back to product_type and generic fidelity wording', () => {
  const f = fallbackProfile({ title: 'Morning Blend', productType: 'Coffees', tags: [] });
  assert.equal(f.category, 'coffee');
  const p = buildPrompt({ ...{ brandName: 'X', productTitle: 'Morning Blend', angle: 'aesthetic', scene: 0, season: 'fall', colors: { primary: '#000', text: '#000' }, buttonInk: '#fff' }, product: f, voiceAdjectives: [], headline: 'H', cta: 'C' });
  assert.match(p, /- any printed label or logo on it/);
});
