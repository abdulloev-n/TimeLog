import { describe, expect, it } from 'vitest';
import {
  buildReport,
  calculatePeriodTotal,
  prepareInvoiceDraft,
  prepareManualEntry,
  prepareTimerStart,
  recoverRunningTimer,
  splitEntriesByDays,
  stopTimer,
  validateStoredEntry,
  type ReportEntry,
  type TimeEntry,
} from '../../src/domain/index.ts';
import { DAY, HOUR, MIN, T0, makeEntry, uuid } from './fixtures.ts';

const P = uuid(500);
const valid: TimeEntry = makeEntry({ id: uuid(1), startAt: T0, endAt: T0 + HOUR, projectId: P, hourlyRateMinor: 2500 });

function broken(fields: Record<string, unknown>): TimeEntry {
  return { ...valid, ...fields } as unknown as TimeEntry;
}

describe('validateStoredEntry', () => {
  it('accepts a valid finished entry and returns a copy', () => {
    const r = validateStoredEntry(valid);
    expect(r).toEqual({ ok: true, value: valid });
    expect(r.ok && r.value).not.toBe(valid);
  });

  it('accepts a running entry, including one that starts after nowMs (clock change)', () => {
    expect(validateStoredEntry(makeEntry({ id: uuid(2), startAt: T0 })).ok).toBe(true);
  });

  it.each([
    ['id is not a UUID', { id: 'abc' }, 'INVALID_ID', 'entry.id'],
    ['id is UUID v1', { id: '00000000-0000-1000-8000-000000000001' }, 'INVALID_ID', 'entry.id'],
    ['projectId is not a UUID', { projectId: 'p1' }, 'INVALID_ID', 'entry.projectId'],
    ['projectId is undefined', { projectId: undefined }, 'INVALID_ID', 'entry.projectId'],
    ['startAt is fractional', { startAt: T0 + 0.5 }, 'INVALID_TIMESTAMP', 'entry.startAt'],
    ['startAt is a string', { startAt: String(T0) }, 'INVALID_TIMESTAMP', 'entry.startAt'],
    ['endAt is NaN', { endAt: Number.NaN }, 'INVALID_TIMESTAMP', 'entry.endAt'],
    ['finished entry lasts 59 999 ms', { endAt: T0 + 59_999 }, 'ENTRY_TOO_SHORT', 'entry.endAt'],
    ['finished entry lasts 24 h + 1 ms', { endAt: T0 + DAY + 1 }, 'ENTRY_TOO_LONG', 'entry.endAt'],
    ['finished entry ends before it starts', { endAt: T0 - MIN }, 'ENTRY_END_NOT_AFTER_START', 'entry.endAt'],
    ['note is missing', { note: undefined }, 'INVALID_TEXT', 'entry.note'],
    ['note is a number', { note: 5 }, 'INVALID_TEXT', 'entry.note'],
    ['note is too long', { note: 'x'.repeat(2001) }, 'TEXT_TOO_LONG', 'entry.note'],
    ['billable is 1', { billable: 1 }, 'INVALID_BOOLEAN', 'entry.billable'],
    ['billable is "yes"', { billable: 'yes' }, 'INVALID_BOOLEAN', 'entry.billable'],
    ['rate is negative', { hourlyRateMinor: -1 }, 'NEGATIVE_RATE', 'entry.hourlyRateMinor'],
    ['rate is fractional', { hourlyRateMinor: 10.5 }, 'INVALID_RATE', 'entry.hourlyRateMinor'],
    ['currency is unsupported', { currency: 'JPY' }, 'UNSUPPORTED_CURRENCY', 'entry.currency'],
    ['no project but a rate', { projectId: null, hourlyRateMinor: 100 }, 'INVALID_PROJECTLESS_SNAPSHOT', 'entry.hourlyRateMinor'],
    ['no project but EUR', { projectId: null, hourlyRateMinor: null, currency: 'EUR' }, 'INVALID_PROJECTLESS_SNAPSHOT', 'entry.hourlyRateMinor'],
  ])('rejects an entry where %s', (_label, fields, code, field) => {
    const r = validateStoredEntry(broken(fields));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(code);
      expect(r.error.field).toBe(field);
    }
  });

  it('rejects non-objects', () => {
    expect(validateStoredEntry(null)).toMatchObject({ ok: false, error: { code: 'INVALID_ENTRY' } });
    expect(validateStoredEntry([])).toMatchObject({ ok: false, error: { code: 'INVALID_ENTRY' } });
  });
});

describe('functions that accept stored entries run the full check', () => {
  const bad = broken({ billable: 'yes' });
  const ctxBad = { entries: [valid, bad], nowMs: T0 + 2 * DAY };
  const period = { startMs: T0 - HOUR, endMs: T0 + DAY };

  function expectField(r: { ok: boolean; error?: { code: string; field?: string } }, code: string, field: string) {
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code, field });
  }

  it('recoverRunningTimer', () => {
    expectField(recoverRunningTimer([valid, bad], T0 + 2 * DAY), 'INVALID_BOOLEAN', 'entries[1].billable');
  });

  it('recoverRunningTimer still reports a clock change for a valid running entry', () => {
    const running = makeEntry({ id: uuid(3), startAt: T0 + HOUR });
    const r = recoverRunningTimer([valid, running], T0 + 30 * MIN);
    expect(r.ok && r.value.kind).toBe('clock-changed');
  });

  it('prepareManualEntry and prepareTimerStart check the context entries', () => {
    expectField(
      prepareManualEntry({ id: uuid(9), project: null, startAt: T0 + 3 * DAY, endAt: T0 + 3 * DAY + HOUR }, ctxBad),
      'INVALID_BOOLEAN',
      'ctx.entries[1].billable',
    );
    expectField(prepareTimerStart({ id: uuid(9), project: null }, ctxBad), 'INVALID_BOOLEAN', 'ctx.entries[1].billable');
  });

  it('stopTimer checks the entry it stops', () => {
    const runningBad = { ...makeEntry({ id: uuid(4), startAt: T0 }), note: 7 } as unknown as TimeEntry;
    expectField(stopTimer(runningBad, { entries: [], nowMs: T0 + HOUR }), 'INVALID_TEXT', 'entry.note');
  });

  it('splitEntriesByDays and calculatePeriodTotal', () => {
    expectField(splitEntriesByDays([valid, bad], [period], T0 + 2 * DAY), 'INVALID_BOOLEAN', 'entries[1].billable');
    expectField(calculatePeriodTotal([valid, bad], period, T0 + 2 * DAY), 'INVALID_BOOLEAN', 'entries[1].billable');
  });

  it('buildReport, including tag ids', () => {
    const reportBad = { ...broken({ endAt: T0 + 30_000 }), tagIds: [] } as ReportEntry;
    expectField(
      buildReport({ period, entries: [reportBad], projects: [], tags: [], nowMs: T0 + 2 * DAY }),
      'ENTRY_TOO_SHORT',
      'entries[0].endAt',
    );
    const badTag = { ...valid, tagIds: ['not-a-uuid'] } as ReportEntry;
    expectField(
      buildReport({ period, entries: [badTag], projects: [], tags: [], nowMs: T0 + 2 * DAY }),
      'INVALID_ID',
      'entries[0].tagIds[0]',
    );
  });

  it('prepareInvoiceDraft', () => {
    const projectless = broken({ projectId: null, hourlyRateMinor: 500 });
    expectField(
      prepareInvoiceDraft({
        client: { id: uuid(301), name: 'Lumen', email: null, address: null },
        sender: { name: 'Nazir' },
        period,
        entries: [projectless],
        projects: [],
      }),
      'INVALID_PROJECTLESS_SNAPSHOT',
      'entries[0].hourlyRateMinor',
    );
  });
});

