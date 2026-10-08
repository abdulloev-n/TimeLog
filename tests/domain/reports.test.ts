import { describe, expect, it } from 'vitest';
import { buildReport, type ProjectInfo, type ReportEntry, type Tag } from '../../src/domain/index.ts';
import { DAY, HOUR, MIN, T0, deepFreeze, makeEntry, uuid } from './fixtures.ts';

const D = T0 - 9 * HOUR;
const PERIOD = { startMs: D, endMs: D + 7 * DAY };
const P1 = uuid(101);
const P2 = uuid(102);
const TAG_A = uuid(201);
const TAG_B = uuid(202);

const projects: ProjectInfo[] = [
  { id: P1, name: 'Brand identity', clientId: uuid(301), archived: false },
  { id: P2, name: 'Archive site', clientId: uuid(301), archived: true },
];
const tags: Tag[] = [
  { id: TAG_A, name: 'design' },
  { id: TAG_B, name: 'calls' },
];

let counter = 0;
function entry(fields: Partial<ReportEntry> & { startAt: number }): ReportEntry {
  counter += 1;
  return { ...makeEntry({ id: uuid(counter), ...fields }), tagIds: fields.tagIds ?? [] };
}

function report(entries: ReportEntry[], days?: { startMs: number; endMs: number }[]) {
  const input = days ? { period: PERIOD, days, entries, projects, tags, nowMs: D + 8 * DAY } : { period: PERIOD, entries, projects, tags, nowMs: D + 8 * DAY };
  const r = buildReport(deepFreeze(input));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe('buildReport', () => {
  it('counts hours for nonbillable entries but no earnings', () => {
    const r = report([
      entry({ startAt: D, endAt: D + HOUR, projectId: P1, hourlyRateMinor: 3000 }),
      entry({ startAt: D + HOUR, endAt: D + 3 * HOUR, projectId: P1, hourlyRateMinor: 3000, billable: false }),
    ]);
    expect(r.totalMs).toBe(3 * HOUR);
    expect(r.billableMs).toBe(HOUR);
    expect(r.byProject[0]).toMatchObject({ projectId: P1, durationMs: 3 * HOUR, billableMs: HOUR, nonBillableMs: 2 * HOUR });
    expect(r.byProject[0]?.earnings).toEqual([{ currency: 'USD', billableMs: HOUR, ratedBillableMs: HOUR, amountMinor: 3000 }]);
    expect(r.totalsByCurrency).toEqual([{ currency: 'USD', billableMs: HOUR, ratedBillableMs: HOUR, amountMinor: 3000 }]);
  });

  it('rounds once per projectId + currency + rate group, not per entry', () => {
    // Each minute at 25.50/h is 42.5 cents. Same group: two minutes are exactly 85, not 43 + 43.
    const r = report([
      entry({ startAt: D, endAt: D + MIN, projectId: P1, hourlyRateMinor: 2550 }),
      entry({ startAt: D + HOUR, endAt: D + HOUR + MIN, projectId: P1, hourlyRateMinor: 2550 }),
    ]);
    expect(r.byProject[0]?.earnings[0]?.amountMinor).toBe(85);
  });

  it('uses historical rate snapshots and exposes them', () => {
    const r = report([
      entry({ startAt: D, endAt: D + HOUR, projectId: P1, hourlyRateMinor: 2000 }),
      entry({ startAt: D + DAY, endAt: D + DAY + HOUR, projectId: P1, hourlyRateMinor: 3000 }),
    ]);
    const row = r.byProject[0];
    expect(row?.earnings).toEqual([{ currency: 'USD', billableMs: 2 * HOUR, ratedBillableMs: 2 * HOUR, amountMinor: 5000 }]);
    expect(row?.hasMultipleRates).toBe(true);
    expect(row?.hasMultipleCurrencies).toBe(false);
    expect(row?.rateSnapshots.map((s) => [s.hourlyRateMinor, s.amountMinor])).toEqual([
      [2000, 2000],
      [3000, 3000],
    ]);
    // Rate rows add up to the project amount.
    expect((row?.rateSnapshots ?? []).reduce((sum, s) => sum + s.amountMinor, 0)).toBe(row?.earnings[0]?.amountMinor);
  });

  it('groups totals by currency and never adds currencies together', () => {
    const r = report([
      entry({ startAt: D, endAt: D + HOUR, projectId: P1, hourlyRateMinor: 1000, currency: 'USD' }),
      entry({ startAt: D + HOUR, endAt: D + 3 * HOUR, projectId: P2, hourlyRateMinor: 2000, currency: 'EUR' }),
      entry({ startAt: D + 3 * HOUR, endAt: D + 4 * HOUR, projectId: P1, hourlyRateMinor: 1500, currency: 'EUR' }),
    ]);
    expect(r.totalsByCurrency.map((t) => [t.currency, t.amountMinor])).toEqual([
      ['USD', 1000],
      ['EUR', 5500],
    ]);
    const p1 = r.byProject.find((p) => p.projectId === P1);
    expect(p1?.hasMultipleCurrencies).toBe(true);
    expect(p1?.earnings.map((e) => [e.currency, e.amountMinor])).toEqual([
      ['USD', 1000],
      ['EUR', 1500],
    ]);
    expect(r.byProject.find((p) => p.projectId === P2)).toMatchObject({ projectName: 'Archive site', archived: true });
  });

  it('puts projectless entries in a No project group with zero earnings', () => {
    const r = report([
      entry({ startAt: D, endAt: D + HOUR, projectId: P1, hourlyRateMinor: 1000 }),
      entry({ startAt: D + HOUR, endAt: D + 2 * HOUR }),
    ]);
    const last = r.byProject[r.byProject.length - 1];
    expect(last).toMatchObject({ projectId: null, projectName: 'No project', unratedBillableMs: HOUR });
    expect(last?.earnings).toEqual([{ currency: 'USD', billableMs: HOUR, ratedBillableMs: 0, amountMinor: 0 }]);
    expect(r.totalsByCurrency).toEqual([{ currency: 'USD', billableMs: 2 * HOUR, ratedBillableMs: HOUR, amountMinor: 1000 }]);
  });

  it('counts an entry toward each of its tags', () => {
    const r = report([
      entry({ startAt: D, endAt: D + HOUR, tagIds: [TAG_A, TAG_B] }),
      entry({ startAt: D + HOUR, endAt: D + 90 * MIN, tagIds: [TAG_A] }),
      entry({ startAt: D + 2 * HOUR, endAt: D + 2 * HOUR + 15 * MIN }),
    ]);
    expect(r.totalMs).toBe(105 * MIN);
    expect(r.byTag).toEqual([
      { tagId: TAG_B, tagName: 'calls', durationMs: HOUR },
      { tagId: TAG_A, tagName: 'design', durationMs: 90 * MIN },
    ]);
    expect(r.untaggedMs).toBe(15 * MIN);
    // Tag totals (150 min) exceed total hours (105 min) by design.
    expect(r.byTag.reduce((s, t) => s + t.durationMs, 0)).toBe(150 * MIN);
  });

  it('clips entries to the report period before calculating', () => {
    const r = report([entry({ startAt: D - 30 * MIN, endAt: D + 30 * MIN, projectId: P1, hourlyRateMinor: 6000 })]);
    expect(r.totalMs).toBe(30 * MIN);
    expect(r.totalsByCurrency[0]?.amountMinor).toBe(3000);
  });

  it('returns totals per supplied day', () => {
    const days = [
      { startMs: D, endMs: D + DAY },
      { startMs: D + DAY, endMs: D + 2 * DAY },
    ];
    const r = report([entry({ startAt: D + 23 * HOUR, endAt: D + DAY + 2 * HOUR })], days);
    expect(r.byDay.map((d) => d.durationMs)).toEqual([HOUR, 2 * HOUR]);
  });

  it('rejects day periods outside the report period', () => {
    const r = buildReport({ period: PERIOD, days: [{ startMs: D - DAY, endMs: D }], entries: [], projects, tags, nowMs: D });
    expect(!r.ok && r.error.code).toBe('PERIOD_OUTSIDE_RANGE');
  });
});

