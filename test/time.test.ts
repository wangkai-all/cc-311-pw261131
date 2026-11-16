import assert from 'node:assert/strict';
import test from 'node:test';
import { dayBoundsUtc, enumerateDates, localWallToUtc, addDays, diffDays, isWeekendDate } from '../src/time.js';

test('normal day is 96 intervals at 15 minutes', () => {
  const d = dayBoundsUtc('2026-08-18', 'America/Chicago');
  assert.equal(d.intervals, 96);
  assert.equal(d.minutes, 1440);
  assert.equal(d.dstTransition, false);
  assert.equal(d.startOffsetMinutes, -300);
});

test('spring-forward day is 92 intervals and reports the transition', () => {
  const d = dayBoundsUtc('2026-03-08', 'America/Chicago');
  assert.equal(d.minutes, 1380);
  assert.equal(d.intervals, 92);
  assert.equal(d.dstTransition, true);
  assert.notEqual(d.startOffsetMinutes, d.endOffsetMinutes);
});

test('fall-back day is 100 intervals', () => {
  const d = dayBoundsUtc('2026-11-01', 'America/New_York');
  assert.equal(d.minutes, 1500);
  assert.equal(d.intervals, 100);
  assert.equal(d.dstTransition, true);
});

test('Phoenix never observes DST', () => {
  for (const date of ['2026-03-08', '2026-11-01']) {
    const d = dayBoundsUtc(date, 'America/Phoenix');
    assert.equal(d.intervals, 96);
    assert.equal(d.dstTransition, false);
  }
});

test('wall time maps to the correct UTC instant on both sides of a transition', () => {
  const before = localWallToUtc('2026-11-01', '00:30', 'America/New_York');
  const after = localWallToUtc('2026-11-01', '03:30', 'America/New_York');
  assert.equal(new Date(before).toISOString(), '2026-11-01T04:30:00.000Z');
  assert.equal(new Date(after).toISOString(), '2026-11-01T08:30:00.000Z');
});

test('nonexistent local time resolves forward instead of producing NaN', () => {
  const ts = localWallToUtc('2026-03-08', '02:30', 'America/Chicago');
  assert.ok(Number.isFinite(ts));
  const back = new Date(ts).toISOString();
  assert.equal(back, '2026-03-08T08:30:00.000Z');
});

test('date arithmetic crosses months and year boundaries', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(diffDays('2026-01-01', '2026-03-01'), 59);
  assert.equal(isWeekendDate('2026-08-16'), true);
  assert.equal(isWeekendDate('2026-08-18'), false);
});

test('enumerateDates is inclusive', () => {
  assert.deepEqual(enumerateDates('2026-08-29', '2026-09-01'), ['2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01']);
});
