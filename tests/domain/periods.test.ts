import { describe, expect, it } from 'vitest';
import {
  calculateDailyGoalProgress,
  calculateGoalProgress,
  calculatePeriodTotal,
  calculateWeeklyGoalProgress,
  clipEntryToPeriod,
  splitEntriesByDays,
} from '../../src/domain/index.ts';
import { DAY, HOUR, MIN, T0, deepFreeze, makeEntry, uuid } from './fixtures.ts';

const A = uuid(1);
const B = uuid(2);
/** A local midnight, supplied by the caller. */
const D = T0 - 9 * HOUR;

describe('clipEntryToPeriod', () => {
  it('returns the part inside the period and flags continuation', () => {
    const entry = makeEntry({ id: A, startAt: D + 22 * HOUR, endAt: D + 26 * HOUR });
    expect(clipEntryToPeriod(entry, { startMs: D, endMs: D + DAY }, 0)).toEqual({
      entryId: A,
      startMs: D + 22 * HOUR,
      endMs: D + DAY,
      durationMs: 2 * HOUR,
      running: false,
      continuesBefore: false,
      continuesAfter: true,
    });
  });

  it('returns null outside the period and for touching ends', () => {
    const entry = makeEntry({ id: A, startAt: D - HOUR, endAt: D });
    expect(clipEntryToPeriod(entry, { startMs: D, endMs: D + DAY }, 0)).toBeNull();
  });

  it('ends a running entry at nowMs', () => {
    const running = makeEntry({ id: A, startAt: D + 10 * HOUR });
    const seg = clipEntryToPeriod(running, { startMs: D, endMs: D + DAY }, D + 12 * HOUR + 30 * MIN);
    expect(seg).toMatchObject({ durationMs: 2 * HOUR + 30 * MIN, running: true, continuesAfter: false });
  });
});

describe('splitEntriesByDays', () => {
  it('splits an entry across local midnight and keeps the entry id', () => {
    // 23:00 to 01:30
    const entry = makeEntry({ id: A, startAt: D + 23 * HOUR, endAt: D + DAY + 90 * MIN });
    const days = [
      { startMs: D, endMs: D + DAY },
      { startMs: D + DAY, endMs: D + 2 * DAY },
    ];
    const r = splitEntriesByDays(deepFreeze([entry]), deepFreeze(days), D + 3 * DAY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((d) => d.totalMs)).toEqual([HOUR, 90 * MIN]);
    expect(r.value[0]?.segments[0]).toMatchObject({ entryId: A, continuesAfter: true });
    expect(r.value[1]?.segments[0]).toMatchObject({ entryId: A, continuesBefore: true });
  });

  it('handles a supplied 23-hour day', () => {
    // Spring-forward day: 23 hours long.
    const day1 = { startMs: D, endMs: D + 23 * HOUR };
    const day2 = { startMs: D + 23 * HOUR, endMs: D + 47 * HOUR };
    const entry = makeEntry({ id: A, startAt: D + 22 * HOUR, endAt: D + 24 * HOUR });
    const r = splitEntriesByDays([entry], [day1, day2], D + 3 * DAY);
    expect(r.ok && r.value.map((d) => d.totalMs)).toEqual([HOUR, HOUR]);
  });

  it('handles a supplied 25-hour day holding a full 24-hour entry', () => {
    const day1 = { startMs: D, endMs: D + 25 * HOUR };
    const day2 = { startMs: D + 25 * HOUR, endMs: D + 49 * HOUR };
    const entry = makeEntry({ id: A, startAt: D + HOUR, endAt: D + 25 * HOUR });
    const r = splitEntriesByDays([entry], [day1, day2], D + 3 * DAY);
    expect(r.ok && r.value.map((d) => d.totalMs)).toEqual([24 * HOUR, 0]);
  });

  it('includes the running timer up to nowMs', () => {
    const done = makeEntry({ id: A, startAt: D + 8 * HOUR, endAt: D + 9 * HOUR });
    const running = makeEntry({ id: B, startAt: D + 10 * HOUR });
    const r = splitEntriesByDays([running, done], [{ startMs: D, endMs: D + DAY }], D + 10 * HOUR + 15 * MIN);
    expect(r.ok && r.value[0]?.totalMs).toBe(HOUR + 15 * MIN);
    expect(r.ok && r.value[0]?.segments.map((s) => s.entryId)).toEqual([A, B]);
  });

  it('rejects overlapping day periods', () => {
    const r = splitEntriesByDays([], [{ startMs: D, endMs: D + DAY }, { startMs: D + DAY - 1, endMs: D + 2 * DAY }], D);
    expect(!r.ok && r.error.code).toBe('PERIODS_OVERLAP');
  });

  it('rejects an empty period', () => {
    const r = splitEntriesByDays([], [{ startMs: D, endMs: D }], D);
    expect(!r.ok && r.error.code).toBe('INVALID_PERIOD');
  });
});

describe('calculatePeriodTotal', () => {
  it('clips entries to the period', () => {
    const entries = [
      makeEntry({ id: A, startAt: D - HOUR, endAt: D + HOUR }),
      makeEntry({ id: B, startAt: D + 2 * HOUR, endAt: D + 3 * HOUR }),
    ];
    expect(calculatePeriodTotal(entries, { startMs: D, endMs: D + DAY }, D + DAY)).toEqual({ ok: true, value: 2 * HOUR });
  });
});

describe('goal progress', () => {
  it('handles a zero goal without dividing by zero', () => {
    expect(calculateGoalProgress(3 * HOUR, 0)).toEqual({
      ok: true,
      value: {
        actualMs: 3 * HOUR,
        goalMs: 0,
        hasGoal: false,
        fraction: null,
        percent: null,
        ringFraction: 0,
        remainingMs: 0,
        exceededMs: 0,
        reached: false,
      },
    });
  });

  it('allows progress above 100% and clamps the ring', () => {
    const r = calculateGoalProgress(10 * HOUR, 8 * HOUR);
    expect(r.ok && r.value).toMatchObject({ fraction: 1.25, percent: 125, ringFraction: 1, exceededMs: 2 * HOUR, reached: true });
  });

  it('reports partial progress', () => {
    const r = calculateGoalProgress(2 * HOUR, 8 * HOUR);
    expect(r.ok && r.value).toMatchObject({ fraction: 0.25, ringFraction: 0.25, remainingMs: 6 * HOUR, reached: false });
  });

  it('rejects negative goals', () => {
    const r = calculateGoalProgress(HOUR, -1);
    expect(!r.ok && r.error.code).toBe('INVALID_GOAL');
  });

  it('computes daily and weekly progress from entries', () => {
    const entries = [makeEntry({ id: A, startAt: D + 9 * HOUR, endAt: D + 13 * HOUR })];
    const daily = calculateDailyGoalProgress(entries, { startMs: D, endMs: D + DAY }, 8 * HOUR, D + DAY);
    expect(daily.ok && daily.value.fraction).toBe(0.5);
    const weekly = calculateWeeklyGoalProgress(entries, { startMs: D, endMs: D + 7 * DAY }, 40 * HOUR, D + DAY);
    expect(weekly.ok && weekly.value.fraction).toBe(0.1);
  });
});

