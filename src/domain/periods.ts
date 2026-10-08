import { effectiveEndMs, validateStoredEntries, type TimeEntry } from './entries.ts';
import { fail, ok, type Result } from './result.ts';
import { validateNonNegativeInteger, validateTimestamp } from './validation.ts';

/**
 * Half-open period [startMs, endMs). The caller computes local midnights,
 * so a day period may last 23, 24 or 25 hours.
 */
export interface Period {
  readonly startMs: number;
  readonly endMs: number;
}

export interface EntrySegment {
  /** The original entry id. One entry can produce several segments. */
  readonly entryId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  readonly running: boolean;
  /** The entry started before this segment (for example, the previous day). */
  readonly continuesBefore: boolean;
  /** The entry ends after this segment (for example, the next day). */
  readonly continuesAfter: boolean;
}

export interface DaySegments {
  readonly period: Period;
  readonly segments: readonly EntrySegment[];
  readonly totalMs: number;
}

export interface GoalProgress {
  readonly actualMs: number;
  readonly goalMs: number;
  /** False when the goal is 0. */
  readonly hasGoal: boolean;
  /** actual / goal. Null without a goal. May exceed 1. */
  readonly fraction: number | null;
  /** fraction * 100. Null without a goal. May exceed 100. */
  readonly percent: number | null;
  /** fraction clamped to 0..1 for a progress ring. 0 without a goal. */
  readonly ringFraction: number;
  readonly remainingMs: number;
  readonly exceededMs: number;
  readonly reached: boolean;
}

export function validatePeriod(period: unknown, field = 'period'): Result<Period> {
  if (typeof period !== 'object' || period === null) {
    return fail('INVALID_PERIOD', `${field} must have startMs and endMs.`, { field });
  }
  const p = period as { startMs?: unknown; endMs?: unknown };
  const start = validateTimestamp(p.startMs, `${field}.startMs`);
  if (!start.ok) return start;
  const end = validateTimestamp(p.endMs, `${field}.endMs`);
  if (!end.ok) return end;
  if (end.value <= start.value) {
    return fail('INVALID_PERIOD', `${field}.endMs must be after ${field}.startMs.`, { field });
  }
  return ok({ startMs: start.value, endMs: end.value });
}

/** Validates day periods. They must not overlap. Gaps are allowed. Input order is kept. */
export function validateDayPeriods(days: readonly Period[]): Result<readonly Period[]> {
  const validated: Period[] = [];
  for (let i = 0; i < days.length; i += 1) {
    const day = validatePeriod(days[i], `days[${i}]`);
    if (!day.ok) return day;
    validated.push(day.value);
  }
  const sorted = [...validated].sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1] as Period;
    const current = sorted[i] as Period;
    if (current.startMs < previous.endMs) {
      return fail('PERIODS_OVERLAP', 'Day periods must not overlap.', { field: 'days' });
    }
  }
  return ok(validated);
}

export function clipInterval(startMs: number, endMs: number, period: Period): Period | null {
  const start = Math.max(startMs, period.startMs);
  const end = Math.min(endMs, period.endMs);
  return end > start ? { startMs: start, endMs: end } : null;
}

/** The part of an entry inside a period. A running entry ends at nowMs. */
export function clipEntryToPeriod(entry: TimeEntry, period: Period, nowMs: number): EntrySegment | null {
  const end = effectiveEndMs(entry, nowMs);
  const clipped = clipInterval(entry.startAt, end, period);
  if (clipped === null) return null;
  return {
    entryId: entry.id,
    startMs: clipped.startMs,
    endMs: clipped.endMs,
    durationMs: clipped.endMs - clipped.startMs,
    running: entry.endAt === null,
    continuesBefore: entry.startAt < clipped.startMs,
    continuesAfter: end > clipped.endMs,
  };
}

function compareSegments(a: EntrySegment, b: EntrySegment): number {
  if (a.startMs !== b.startMs) return a.startMs - b.startMs;
  return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
}

/** Splits entries across supplied day periods. Output order matches `days`. */
export function splitEntriesByDays(
  entries: readonly TimeEntry[],
  days: readonly Period[],
  nowMs: number,
): Result<readonly DaySegments[]> {
  const now = validateTimestamp(nowMs, 'nowMs');
  if (!now.ok) return now;
  const validDays = validateDayPeriods(days);
  if (!validDays.ok) return validDays;
  const stored = validateStoredEntries(entries, 'entries');
  if (!stored.ok) return stored;
  return ok(
    validDays.value.map((period) => {
      const segments = stored.value
        .map((entry) => clipEntryToPeriod(entry, period, nowMs))
        .filter((s): s is EntrySegment => s !== null)
        .sort(compareSegments);
      return { period, segments, totalMs: segments.reduce((sum, s) => sum + s.durationMs, 0) };
    }),
  );
}

export function calculatePeriodTotal(entries: readonly TimeEntry[], period: Period, nowMs: number): Result<number> {
  const now = validateTimestamp(nowMs, 'nowMs');
  if (!now.ok) return now;
  const valid = validatePeriod(period);
  if (!valid.ok) return valid;
  const stored = validateStoredEntries(entries, 'entries');
  if (!stored.ok) return stored;
  let total = 0;
  for (const entry of stored.value) {
    const segment = clipEntryToPeriod(entry, valid.value, nowMs);
    if (segment !== null) total += segment.durationMs;
  }
  return ok(total);
}

export function calculateGoalProgress(actualMs: number, goalMs: number): Result<GoalProgress> {
  const actual = validateNonNegativeInteger(actualMs, 'actualMs');
  if (!actual.ok) return actual;
  if (typeof goalMs !== 'number' || !Number.isSafeInteger(goalMs) || goalMs < 0) {
    return fail('INVALID_GOAL', 'The goal must be a nonnegative whole number of milliseconds.', { field: 'goalMs' });
  }
  if (goalMs === 0) {
    return ok({
      actualMs,
      goalMs,
      hasGoal: false,
      fraction: null,
      percent: null,
      ringFraction: 0,
      remainingMs: 0,
      exceededMs: 0,
      reached: false,
    });
  }
  const fraction = actualMs / goalMs;
  return ok({
    actualMs,
    goalMs,
    hasGoal: true,
    fraction,
    percent: fraction * 100,
    ringFraction: Math.min(1, Math.max(0, fraction)),
    remainingMs: Math.max(0, goalMs - actualMs),
    exceededMs: Math.max(0, actualMs - goalMs),
    reached: actualMs >= goalMs,
  });
}

export function calculateDailyGoalProgress(
  entries: readonly TimeEntry[],
  day: Period,
  dailyGoalMs: number,
  nowMs: number,
): Result<GoalProgress> {
  const total = calculatePeriodTotal(entries, day, nowMs);
  if (!total.ok) return total;
  return calculateGoalProgress(total.value, dailyGoalMs);
}

export function calculateWeeklyGoalProgress(
  entries: readonly TimeEntry[],
  week: Period,
  weeklyGoalMs: number,
  nowMs: number,
): Result<GoalProgress> {
  const total = calculatePeriodTotal(entries, week, nowMs);
  if (!total.ok) return total;
  return calculateGoalProgress(total.value, weeklyGoalMs);
}

