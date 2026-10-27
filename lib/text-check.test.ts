import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeText } from './text-check';

const H = 'Style you can hold onto';
const C = 'Shop Now';
const read = (adText: string[], sceneText: string[] = [], productText: string[] = ['loopy']) => judgeText({ adText, productText, sceneText, defects: [] }, H, C);

test('passes when the headline (even split over two lines) and the CTA appear once', () => {
  assert.deepEqual(read(['Style you can hold onto', 'Shop Now']), { pass: true, reason: null });
  assert.deepEqual(read(['Style you can', 'hold onto', 'SHOP NOW']), { pass: true, reason: null });
});

test('fails the bake-off doubled headline, misspellings, extra text and legible props', () => {
  assert.equal(read([H, H, C]).reason, 'headline appears 2×');
  assert.match(read(['Style you can hold on to', C]).reason!, /headline not found/);
  assert.match(read([H, C, '20% OFF']).reason!, /extra text "20% off"/);
  assert.match(read([H, C], ['COFFEE CO']).reason!, /legible words in the scene/);
});

test('text on the product itself is allowed', () => {
  assert.equal(read([H, C], [], ['loopy', 'p']).pass, true);
});

test('a headline split over three lines still matches (seen on Loopy, M4)', () => {
  assert.equal(judgeText({ adText: ['Try Loopy', 'risk-free for', '30 days', 'See Why'], productText: [], sceneText: [], defects: [] }, 'Try Loopy risk-free for 30 days', 'See Why').pass, true);
});

test('a clear visual defect fails the render', () => {
  const r = judgeText({ adText: [H, C], productText: [], sceneText: [], defects: ['the hand has six fingers'] }, H, C);
  assert.deepEqual(r, { pass: false, reason: 'visual defect: the hand has six fingers' });
});
