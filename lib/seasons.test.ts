import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentSeason, daysUntil, holidayInWindow, holidaysIn, holidayTooClose, seasonIn } from './seasons';

const TODAY = new Date('2026-10-27T12:00:00Z');

test('daysUntil counts to the next occurrence, rolling into next year', () => {
  const [halloween] = holidaysIn('Boo Crew');
  const [christmas] = holidaysIn('Holiday | Neutral Tones');
  const [valentines] = holidaysIn('Be Mine');
  assert.equal(daysUntil(halloween, TODAY), 4);
  assert.equal(daysUntil(christmas, TODAY), 59);
  assert.equal(daysUntil(valentines, TODAY), 110);
  assert.equal(daysUntil(halloween, new Date('2026-10-31T23:00:00Z')), 0);
});

test('the 14-day lead rule and the 14-60 day window', () => {
  const [halloween] = holidaysIn('Witchy Wonder');
  const [christmas] = holidaysIn('Merry & Bright');
  assert.equal(holidayTooClose(halloween, TODAY), true);
  assert.equal(holidayInWindow(christmas, TODAY), true);
  assert.equal(holidayInWindow(christmas, new Date('2026-09-01T00:00:00Z')), false); // 115 days out
});

test('holiday themes are read from real Loopy titles without false alarms', () => {
  for (const t of ['Boo Crew', 'Itsy Bitsy', 'Witchy Wonder', 'Boogie Bones']) assert.equal(holidaysIn(t)[0]?.key, 'halloween', t);
  assert.equal(holidaysIn('Merry & Bright')[0]?.key, 'christmas');
  assert.equal(holidaysIn('Freedom Stars')[0]?.key, 'independence');
  for (const t of ['Lucky Girl Club x Krista Horton', 'Night Sky', 'Cocoa Checkered', 'Raspberry Dots', 'Bookworm']) assert.deepEqual(holidaysIn(t), [], t);
});

test('seasons by month and from collection titles', () => {
  assert.equal(currentSeason(TODAY), 'fall');
  assert.equal(currentSeason(new Date('2026-12-05T00:00:00Z')), 'winter');
  assert.equal(seasonIn('Fall Favorites'), 'fall');
  assert.equal(seasonIn('Summer Favorites'), 'summer');
  assert.equal(seasonIn('Falling Stars'), null);
});
