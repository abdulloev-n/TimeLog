import type { TimeEntry } from '../../src/domain/index.ts';

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** 2026-10-01 09:00:00 UTC */
export const T0 = 1_790_845_200_000;

/** Deterministic valid UUID v4 values for tests. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export function makeEntry(fields: Partial<TimeEntry> & { id: string; startAt: number }): TimeEntry {
  return {
    projectId: null,
    endAt: null,
    note: '',
    billable: true,
    hourlyRateMinor: null,
    currency: 'USD',
    ...fields,
  };
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

