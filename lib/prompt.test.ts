import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basePrompt, buildPrompt, EDIT_PREFIX, editPrompt, REVISION_MARKER, revisedPrompt } from './prompt';

const v1 = buildPrompt({
  brandName: 'Loopy',
  productTitle: 'Night Sky',
  isHero: true,
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
