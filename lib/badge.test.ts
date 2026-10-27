import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeBadge } from './generate';

const size = { bw: 281, bh: 106 };

test('the badge sits beside a narrow CTA, on the left', () => {
  const p = placeBadge({ x0: 360, y0: 1700, x1: 720, y1: 1800 }, size);
  assert.equal(p.x, 43);
  assert.ok(Math.abs(p.y + size.bh / 2 - 1750) <= 1);
});

test('a CTA hugging the left puts the badge on the right', () => {
  const p = placeBadge({ x0: 60, y0: 1700, x1: 600, y1: 1800 }, size);
  assert.ok(p.x > 600);
});

test('a CTA too wide for either side puts the badge below it, or in the top corner, never over the scene', () => {
  const below = placeBadge({ x0: 200, y0: 1600, x1: 900, y1: 1700 }, size);
  assert.ok(below.y > 1700);
  const corner = placeBadge({ x0: 200, y0: 1700, x1: 900, y1: 1840 }, size);
  assert.ok(corner.y < 100);
});
