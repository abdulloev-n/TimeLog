import { describe, expect, it } from 'vitest';
import {
  findOverlappingEntry,
  intervalsOverlap,
  prepareEntryEdit,
  prepareEntryRateChange,
  prepareManualEntry,
  prepareProject,
  prepareTimerStart,
  recoverRunningTimer,
  stopTimer,
  updateProject,
  type EntryContext,
  type Project,
  type TimeEntry,
} from '../../src/domain/index.ts';
import { DAY, HOUR, MIN, T0, deepFreeze, makeEntry, uuid } from './fixtures.ts';

function ctx(entries: TimeEntry[], nowMs: number, projectNames?: Record<string, string>): EntryContext {
  return deepFreeze(projectNames ? { entries, nowMs, projectNames } : { entries, nowMs });
}

function expectError(result: { ok: boolean; error?: { code: string } }, codeValue: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error?.code).toBe(codeValue);
}

const A = uuid(1);
const B = uuid(2);
const NEW = uuid(99);
const P = uuid(500);

describe('intervalsOverlap', () => {
  it('treats touching intervals as adjacent', () => {
    expect(intervalsOverlap({ startMs: 0, endMs: 10 }, { startMs: 10, endMs: 20 })).toBe(false);
  });
  it('detects shared time', () => {
    expect(intervalsOverlap({ startMs: 0, endMs: 11 }, { startMs: 10, endMs: 20 })).toBe(true);
  });
  it('ignores empty intervals', () => {
    expect(intervalsOverlap({ startMs: 5, endMs: 5 }, { startMs: 0, endMs: 10 })).toBe(false);
  });
});

describe('manual entries', () => {
  const existing = makeEntry({ id: A, startAt: T0, endAt: T0 + HOUR, note: 'Design review' });

  it('allows an entry that starts exactly when another ends', () => {
    const r = prepareManualEntry({ id: NEW, project: null, startAt: T0 + HOUR, endAt: T0 + 2 * HOUR }, ctx([existing], T0 + 5 * HOUR));
    expect(r.ok).toBe(true);
  });

  it('rejects an overlap and identifies the conflicting entry', () => {
    const r = prepareManualEntry(
      { id: NEW, project: null, startAt: T0 + 30 * MIN, endAt: T0 + 90 * MIN },
      ctx([existing], T0 + 5 * HOUR),
    );
    expectError(r, 'ENTRY_OVERLAP');
    if (!r.ok) {
      expect(r.error.conflict).toMatchObject({
        entryId: A,
        startAt: T0,
        endAt: T0 + HOUR,
        running: false,
        note: 'Design review',
        label: 'Design review',
      });
    }
  });

  it('uses the project name as the conflict label when the note is empty', () => {
    const withProject = makeEntry({ id: A, startAt: T0, endAt: T0 + HOUR, projectId: P });
    const r = prepareManualEntry(
      { id: NEW, project: null, startAt: T0, endAt: T0 + 10 * MIN },
      ctx([withProject], T0 + 5 * HOUR, { [P]: 'Georgian menu' }),
    );
    expect(!r.ok && r.error.conflict?.label).toBe('Georgian menu');
  });

  it('enforces the one-minute minimum at 59 999 and 60 000 ms', () => {
    expectError(prepareManualEntry({ id: NEW, project: null, startAt: T0, endAt: T0 + 59_999 }, ctx([], T0)), 'ENTRY_TOO_SHORT');
    expect(prepareManualEntry({ id: NEW, project: null, startAt: T0, endAt: T0 + 60_000 }, ctx([], T0)).ok).toBe(true);
  });

  it('enforces the 24-hour maximum inclusive', () => {
    expect(prepareManualEntry({ id: NEW, project: null, startAt: T0, endAt: T0 + DAY }, ctx([], T0)).ok).toBe(true);
    expectError(prepareManualEntry({ id: NEW, project: null, startAt: T0, endAt: T0 + DAY + 1 }, ctx([], T0)), 'ENTRY_TOO_LONG');
  });

  it('rejects an end at or before the start', () => {
    expectError(prepareManualEntry({ id: NEW, project: null, startAt: T0, endAt: T0 }, ctx([], T0)), 'ENTRY_END_NOT_AFTER_START');
    expectError(prepareManualEntry({ id: NEW, project: null, startAt: T0, endAt: T0 - MIN }, ctx([], T0)), 'ENTRY_END_NOT_AFTER_START');
  });

  it('allows finished entries in the future', () => {
    const r = prepareManualEntry({ id: NEW, project: null, startAt: T0 + 3 * DAY, endAt: T0 + 3 * DAY + HOUR }, ctx([], T0));
    expect(r.ok).toBe(true);
  });

  it('rejects invalid ids and timestamps', () => {
    expectError(prepareManualEntry({ id: 'not-a-uuid', project: null, startAt: T0, endAt: T0 + HOUR }, ctx([], T0)), 'INVALID_ID');
    expectError(prepareManualEntry({ id: NEW, project: null, startAt: T0 + 0.5, endAt: T0 + HOUR }, ctx([], T0)), 'INVALID_TIMESTAMP');
    expectError(prepareManualEntry({ id: NEW, project: null, startAt: T0, endAt: T0 + HOUR }, ctx([], Number.NaN)), 'INVALID_TIMESTAMP');
  });

  it('trims the description and stores it in note; projectless entries use null rate and USD', () => {
    const r = prepareManualEntry({ id: NEW, project: null, startAt: T0, endAt: T0 + HOUR, note: '  Logo  ' }, ctx([], T0));
    expect(r).toEqual({
      ok: true,
      value: {
        id: NEW,
        projectId: null,
        startAt: T0,
        endAt: T0 + HOUR,
        note: 'Logo',
        billable: true,
        hourlyRateMinor: null,
        currency: 'USD',
      },
    });
  });
});

describe('running timer in overlap checks', () => {
  const running = makeEntry({ id: A, startAt: T0 });
  const now = T0 + HOUR;

  it('treats the running timer as ending at nowMs', () => {
    const r = prepareManualEntry({ id: NEW, project: null, startAt: T0 + 30 * MIN, endAt: T0 + 45 * MIN }, ctx([running], now));
    expectError(r, 'ENTRY_OVERLAP');
    if (!r.ok) expect(r.error.conflict).toMatchObject({ entryId: A, running: true, endAt: null, effectiveEndMs: now });
  });

  it('allows a manual entry that starts at nowMs', () => {
    const r = prepareManualEntry({ id: NEW, project: null, startAt: now, endAt: now + HOUR }, ctx([running], now));
    expect(r.ok).toBe(true);
  });
});

describe('starting a timer', () => {
  const now = T0 + 5 * HOUR;

  it('rejects a start at nowMs inside a finished entry', () => {
    const covering = makeEntry({ id: A, startAt: now - 30 * MIN, endAt: now + 30 * MIN });
    expectError(prepareTimerStart({ id: NEW, project: null }, ctx([covering], now)), 'ENTRY_OVERLAP');
  });

  it('rejects a start at nowMs when a finished entry starts exactly at nowMs', () => {
    const upcoming = makeEntry({ id: A, startAt: now, endAt: now + HOUR });
    expectError(prepareTimerStart({ id: NEW, project: null }, ctx([upcoming], now)), 'ENTRY_OVERLAP');
  });

  it('allows a start at nowMs when the previous entry ends at nowMs', () => {
    const before = makeEntry({ id: A, startAt: now - HOUR, endAt: now });
    const r = prepareTimerStart({ id: NEW, project: null }, ctx([before], now));
    expect(r.ok && r.value.entry).toMatchObject({ id: NEW, startAt: now, endAt: null });
    expect(r.ok && r.value.autoCompleteAt).toBe(now + DAY);
  });

  it('validates the whole elapsed interval for an earlier start', () => {
    const earlier = makeEntry({ id: A, startAt: now - HOUR, endAt: now - 30 * MIN });
    expectError(prepareTimerStart({ id: NEW, project: null, startAt: now - 2 * HOUR }, ctx([earlier], now)), 'ENTRY_OVERLAP');
    expect(prepareTimerStart({ id: NEW, project: null, startAt: now - 30 * MIN }, ctx([earlier], now)).ok).toBe(true);
  });

  it('rejects a future start', () => {
    expectError(prepareTimerStart({ id: NEW, project: null, startAt: now + 1 }, ctx([], now)), 'TIMER_START_IN_FUTURE');
  });

  it('rejects a second running timer', () => {
    const running = makeEntry({ id: A, startAt: now - HOUR });
    const r = prepareTimerStart({ id: NEW, project: null }, ctx([running], now));
    expectError(r, 'TIMER_ALREADY_RUNNING');
    if (!r.ok) expect(r.error.conflict?.entryId).toBe(A);
  });

  it('rejects a start 24 hours or more before now', () => {
    expectError(prepareTimerStart({ id: NEW, project: null, startAt: now - DAY }, ctx([], now)), 'ENTRY_TOO_LONG');
  });

  it('reports the next future entry the timer could run into', () => {
    const future = makeEntry({ id: A, startAt: now + 2 * HOUR, endAt: now + 3 * HOUR });
    const r = prepareTimerStart({ id: NEW, project: null }, ctx([future], now));
    expect(r.ok && r.value.nextEntryStartAt).toBe(now + 2 * HOUR);
  });
});

describe('stopping a timer', () => {
  const running = makeEntry({ id: A, startAt: T0 });

  it('deletes a timer stopped at 59 999 ms', () => {
    expect(stopTimer(running, ctx([running], T0 + 59_999))).toEqual({
      ok: true,
      value: { kind: 'delete-entry', entryId: A, elapsedMs: 59_999 },
    });
  });

  it('keeps a timer stopped at 60 000 ms', () => {
    const r = stopTimer(running, ctx([running], T0 + 60_000));
    expect(r.ok && r.value).toMatchObject({ kind: 'finish', durationMs: 60_000, capped: false, entry: { endAt: T0 + 60_000 } });
  });

  it('finishes at exactly 24 hours without capping', () => {
    const r = stopTimer(running, ctx([running], T0 + DAY));
    expect(r.ok && r.value).toMatchObject({ kind: 'finish', durationMs: DAY, capped: false });
  });

  it('caps a timer that ran past 24 hours at start + 24 h', () => {
    const r = stopTimer(running, ctx([running], T0 + 25 * HOUR));
    expect(r.ok && r.value).toMatchObject({
      kind: 'finish',
      elapsedMs: 25 * HOUR,
      durationMs: DAY,
      capped: true,
      entry: { endAt: T0 + DAY },
    });
  });

  it('checks overlaps again at stop time and never truncates', () => {
    // Created while the timer had only run 10 minutes, so it did not overlap then.
    const later = makeEntry({ id: B, startAt: T0 + 20 * MIN, endAt: T0 + 40 * MIN, note: 'Call' });
    const r = stopTimer(running, ctx([running, later], T0 + 30 * MIN));
    expectError(r, 'ENTRY_OVERLAP');
    if (!r.ok) expect(r.error.conflict).toMatchObject({ entryId: B, startAt: T0 + 20 * MIN, endAt: T0 + 40 * MIN, label: 'Call' });
  });

  it('returns CLOCK_CHANGED for negative elapsed time instead of deleting', () => {
    const futureStart = makeEntry({ id: A, startAt: T0 + 10 * MIN });
    expectError(stopTimer(futureStart, ctx([futureStart], T0)), 'CLOCK_CHANGED');
  });

  it('rejects stopping a finished entry or stopping in the future', () => {
    const finished = makeEntry({ id: A, startAt: T0, endAt: T0 + HOUR });
    expectError(stopTimer(finished, ctx([finished], T0 + 2 * HOUR)), 'TIMER_NOT_RUNNING');
    expectError(stopTimer(running, ctx([running], T0 + HOUR), T0 + 2 * HOUR), 'TIMER_STOP_IN_FUTURE');
  });
});

describe('recoverRunningTimer', () => {
  it('reports no timer', () => {
    expect(recoverRunningTimer([makeEntry({ id: A, startAt: T0, endAt: T0 + HOUR })], T0 + 2 * HOUR)).toEqual({
      ok: true,
      value: { kind: 'none' },
    });
  });

  it('reports elapsed time for a running timer', () => {
    const running = makeEntry({ id: A, startAt: T0 });
    const r = recoverRunningTimer([running], T0 + 2 * HOUR);
    expect(r.ok && r.value).toMatchObject({
      kind: 'running',
      status: { elapsedMs: 2 * HOUR, remainingMs: 22 * HOUR, autoCompleteAt: T0 + DAY },
    });
  });

  it('reports a timer that reached 24 hours while the app was closed', () => {
    const running = makeEntry({ id: A, startAt: T0 });
    const r = recoverRunningTimer([running], T0 + 30 * HOUR);
    expect(r.ok && r.value).toMatchObject({ kind: 'limit-reached', completeAt: T0 + DAY });
    // The suggested completion is a valid stop.
    const stop = stopTimer(running, ctx([running], T0 + 30 * HOUR), T0 + DAY);
    expect(stop.ok && stop.value).toMatchObject({ kind: 'finish', durationMs: DAY, capped: false });
  });

  it('reports a backward clock change', () => {
    const running = makeEntry({ id: A, startAt: T0 + 5 * MIN });
    const r = recoverRunningTimer([running], T0);
    expect(r.ok && r.value).toMatchObject({ kind: 'clock-changed', status: { elapsedMs: -5 * MIN, clockChanged: true } });
  });

  it('reports several running entries', () => {
    const r = recoverRunningTimer([makeEntry({ id: B, startAt: T0 }), makeEntry({ id: A, startAt: T0 + HOUR })], T0 + 2 * HOUR);
    expect(r).toEqual({ ok: true, value: { kind: 'multiple-running', entryIds: [A, B] } });
  });
});

describe('editing entries', () => {
  const a = makeEntry({ id: A, startAt: T0, endAt: T0 + HOUR, projectId: P, hourlyRateMinor: 2000, currency: 'EUR' });

  it('ignores the entry being edited in overlap checks', () => {
    const r = prepareEntryEdit(a, { startAt: T0 + 30 * MIN, endAt: T0 + 90 * MIN }, ctx([a], T0 + 5 * HOUR));
    expect(r.ok && r.value).toMatchObject({ startAt: T0 + 30 * MIN, endAt: T0 + 90 * MIN });
  });

  it('still checks other entries', () => {
    const b = makeEntry({ id: B, startAt: T0 + HOUR, endAt: T0 + 2 * HOUR });
    expectError(prepareEntryEdit(a, { endAt: T0 + 61 * MIN }, ctx([a, b], T0 + 5 * HOUR)), 'ENTRY_OVERLAP');
  });

  it('keeps the rate snapshot unless the project changes', () => {
    const noteOnly = prepareEntryEdit(a, { note: 'Changed' }, ctx([a], T0 + 5 * HOUR));
    expect(noteOnly.ok && noteOnly.value).toMatchObject({ hourlyRateMinor: 2000, currency: 'EUR', note: 'Changed' });

    const moved = prepareEntryEdit(a, { project: { id: uuid(501), hourlyRateMinor: 4500, currency: 'GBP' } }, ctx([a], T0 + 5 * HOUR));
    expect(moved.ok && moved.value).toMatchObject({ projectId: uuid(501), hourlyRateMinor: 4500, currency: 'GBP' });

    const cleared = prepareEntryEdit(a, { project: null }, ctx([a], T0 + 5 * HOUR));
    expect(cleared.ok && cleared.value).toMatchObject({ projectId: null, hourlyRateMinor: null, currency: 'USD' });
  });

  it('applies running rules when the edited entry is running', () => {
    const running = makeEntry({ id: A, startAt: T0 });
    expectError(prepareEntryEdit(running, { startAt: T0 + 2 * HOUR }, ctx([running], T0 + HOUR)), 'TIMER_START_IN_FUTURE');
    const r = prepareEntryEdit(running, { startAt: T0 - 30 * MIN }, ctx([running], T0 + HOUR));
    expect(r.ok && r.value).toMatchObject({ startAt: T0 - 30 * MIN, endAt: null });
  });
});

describe('rate snapshots', () => {
  it('existing entries keep their snapshot after the project rate changes', () => {
    const project = prepareProject({ id: P, name: 'Brand', hourlyRateMinor: 2500, currency: 'USD', createdAt: T0 });
    expect(project.ok).toBe(true);
    if (!project.ok) return;
    const first = prepareManualEntry({ id: A, project: project.value, startAt: T0, endAt: T0 + HOUR }, ctx([], T0));
    expect(first.ok && first.value.hourlyRateMinor).toBe(2500);

    const raised = updateProject(project.value, { hourlyRateMinor: 4000, currency: 'EUR' });
    expect(raised.ok).toBe(true);
    if (!raised.ok || !first.ok) return;
    const updated: Project = raised.value;

    expect(first.value).toMatchObject({ hourlyRateMinor: 2500, currency: 'USD' });
    const second = prepareManualEntry({ id: B, project: updated, startAt: T0 + HOUR, endAt: T0 + 2 * HOUR }, ctx([first.value], T0));
    expect(second.ok && second.value).toMatchObject({ hourlyRateMinor: 4000, currency: 'EUR' });
  });
});

describe('findOverlappingEntry', () => {
  it('returns the earliest conflict and does not mutate inputs', () => {
    const late = makeEntry({ id: B, startAt: T0 + HOUR, endAt: T0 + 2 * HOUR });
    const early = makeEntry({ id: A, startAt: T0, endAt: T0 + HOUR });
    const context = ctx([late, early], T0 + 3 * HOUR);
    expect(findOverlappingEntry({ startMs: T0 + 30 * MIN, endMs: T0 + 90 * MIN }, context)?.entryId).toBe(A);
    expect(context.entries.map((e) => e.id)).toEqual([B, A]);
  });
});

describe('rate snapshot on edit', () => {
  const C = uuid(600);

  function setup() {
    const project = prepareProject({ id: P, name: 'Brand', hourlyRateMinor: 2500, currency: 'USD', createdAt: T0 });
    if (!project.ok) throw new Error(project.error.message);
    const old = prepareManualEntry({ id: A, project: project.value, startAt: T0, endAt: T0 + HOUR, note: 'Logo' }, ctx([], T0));
    if (!old.ok) throw new Error(old.error.message);
    const raised = updateProject(project.value, { hourlyRateMinor: 4000, currency: 'EUR' });
    if (!raised.ok) throw new Error(raised.error.message);
    return { old: old.value, raised: raised.value };
  }

  it('keeps the historical rate when the same project is passed with a new description', () => {
    const { old, raised } = setup();
    const saved = prepareEntryEdit(old, { project: raised, note: 'Logo, second round' }, ctx([old], T0 + 2 * HOUR));
    expect(saved.ok && saved.value).toMatchObject({
      projectId: P,
      note: 'Logo, second round',
      hourlyRateMinor: 2500,
      currency: 'USD',
    });
  });

  it('takes a new snapshot when the project changes', () => {
    const { old } = setup();
    const other = { id: C, hourlyRateMinor: 7000, currency: 'GBP' as const };
    const moved = prepareEntryEdit(old, { project: other }, ctx([old], T0 + 2 * HOUR));
    expect(moved.ok && moved.value).toMatchObject({ projectId: C, hourlyRateMinor: 7000, currency: 'GBP' });
  });

  it('changes one entry rate and currency only through the explicit override', () => {
    const { old, raised } = setup();
    const viaHelper = prepareEntryRateChange(old, { hourlyRateMinor: 4000, currency: 'EUR' }, ctx([old], T0 + 2 * HOUR));
    expect(viaHelper.ok && viaHelper.value).toMatchObject({ projectId: P, hourlyRateMinor: 4000, currency: 'EUR', note: 'Logo' });

    const viaEdit = prepareEntryEdit(
      old,
      { project: raised, rateSnapshot: { hourlyRateMinor: null, currency: 'USD' } },
      ctx([old], T0 + 2 * HOUR),
    );
    expect(viaEdit.ok && viaEdit.value).toMatchObject({ hourlyRateMinor: null, currency: 'USD' });
  });

  it('validates the override', () => {
    const { old } = setup();
    expectError(prepareEntryRateChange(old, { hourlyRateMinor: -1, currency: 'USD' }, ctx([old], T0)), 'NEGATIVE_RATE');
    expectError(prepareEntryRateChange(old, { hourlyRateMinor: 100, currency: 'JPY' as 'USD' }, ctx([old], T0)), 'UNSUPPORTED_CURRENCY');
  });

  it('allows only null rate and USD on an entry without a project', () => {
    const free = makeEntry({ id: B, startAt: T0, endAt: T0 + HOUR });
    expectError(prepareEntryRateChange(free, { hourlyRateMinor: 1000, currency: 'USD' }, ctx([free], T0)), 'INVALID_PROJECTLESS_SNAPSHOT');
    expectError(prepareEntryRateChange(free, { hourlyRateMinor: null, currency: 'EUR' }, ctx([free], T0)), 'INVALID_PROJECTLESS_SNAPSHOT');
    expect(prepareEntryRateChange(free, { hourlyRateMinor: null, currency: 'USD' }, ctx([free], T0)).ok).toBe(true);
    // Removing the project also clears the snapshot.
    const { old } = setup();
    const cleared = prepareEntryEdit(old, { project: null }, ctx([old], T0));
    expect(cleared.ok && cleared.value).toMatchObject({ projectId: null, hourlyRateMinor: null, currency: 'USD' });
  });
});

