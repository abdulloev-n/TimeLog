import { DEFAULT_CURRENCY, validateCurrency, type CurrencyCode } from './currency.ts';
import { fail, ok, type EntryConflict, type Failure, type Result } from './result.ts';
import {
  MAX_ENTRY_DURATION_MS,
  MAX_NOTE_LENGTH,
  MIN_ENTRY_DURATION_MS,
  normalizeNote,
  validateBoolean,
  validateId,
  validateRateMinor,
  validateTimestamp,
} from './validation.ts';

/**
 * One time_entries row. "Date" is not stored: derive it from startAt in local time.
 * "Duration" is not stored: it is endAt - startAt, or nowMs - startAt while running.
 * The UI "Description" maps to note.
 */
export interface TimeEntry {
  readonly id: string;
  readonly projectId: string | null;
  readonly startAt: number;
  /** Null while the timer runs. */
  readonly endAt: number | null;
  readonly note: string;
  readonly billable: boolean;
  /** Rate snapshot taken from the project when the entry got its project. */
  readonly hourlyRateMinor: number | null;
  /** Currency snapshot. USD for entries without a project. */
  readonly currency: CurrencyCode;
}

/** The project fields an entry snapshots. A Project satisfies this shape. */
export interface RateSource {
  readonly id: string;
  readonly hourlyRateMinor: number | null;
  readonly currency: CurrencyCode;
}

export interface EntryRateSnapshot {
  readonly projectId: string | null;
  readonly hourlyRateMinor: number | null;
  readonly currency: CurrencyCode;
}

export interface EntryContext {
  /** Every entry in the database, including the running timer. */
  readonly entries: readonly TimeEntry[];
  readonly nowMs: number;
  /** Optional id -> name map so conflicts can show a project label. */
  readonly projectNames?: Readonly<Record<string, string>>;
}

/** Half-open interval [startMs, endMs). */
export interface Interval {
  readonly startMs: number;
  readonly endMs: number;
}

export function isRunningEntry(entry: TimeEntry): boolean {
  return entry.endAt === null;
}

/** The end used for calculations. A running timer ends at nowMs (never before its start). */
export function effectiveEndMs(entry: TimeEntry, nowMs: number): number {
  return entry.endAt ?? Math.max(nowMs, entry.startAt);
}

/** [a.start, a.end) and [b.start, b.end) share time. Touching ends do not overlap. Empty intervals never overlap. */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.startMs < a.endMs && b.startMs < b.endMs && a.startMs < b.endMs && b.startMs < a.endMs;
}

function compareEntries(a: TimeEntry, b: TimeEntry): number {
  if (a.startAt !== b.startAt) return a.startAt - b.startAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function describeConflict(
  entry: TimeEntry,
  ctx: { readonly nowMs: number; readonly projectNames?: Readonly<Record<string, string>> },
): EntryConflict {
  const trimmed = entry.note.trim();
  const note = trimmed === '' ? null : trimmed;
  let projectName: string | null = null;
  const names = ctx.projectNames;
  if (entry.projectId !== null && names !== undefined && Object.prototype.hasOwnProperty.call(names, entry.projectId)) {
    projectName = names[entry.projectId] ?? null;
  }
  const label = note ?? projectName ?? (entry.projectId === null ? 'No project' : 'Untitled entry');
  return {
    entryId: entry.id,
    startAt: entry.startAt,
    endAt: entry.endAt,
    effectiveEndMs: effectiveEndMs(entry, ctx.nowMs),
    running: entry.endAt === null,
    projectId: entry.projectId,
    projectName,
    note,
    label,
  };
}

/** Returns the earliest entry that overlaps the candidate, or null. */
export function findOverlappingEntry(candidate: Interval, ctx: EntryContext, excludeEntryId?: string): EntryConflict | null {
  const sorted = [...ctx.entries].sort(compareEntries);
  for (const entry of sorted) {
    if (excludeEntryId !== undefined && entry.id === excludeEntryId) continue;
    if (intervalsOverlap(candidate, { startMs: entry.startAt, endMs: effectiveEndMs(entry, ctx.nowMs) })) {
      return describeConflict(entry, ctx);
    }
  }
  return null;
}

function overlapFailure(conflict: EntryConflict): Failure {
  return fail('ENTRY_OVERLAP', `This time overlaps "${conflict.label}". Change the start or end time.`, { conflict });
}

export function snapshotRate(project: RateSource | null): EntryRateSnapshot {
  if (project === null) return { projectId: null, hourlyRateMinor: null, currency: DEFAULT_CURRENCY };
  return { projectId: project.id, hourlyRateMinor: project.hourlyRateMinor, currency: project.currency };
}

function validateRateSource(project: RateSource | null): Result<EntryRateSnapshot> {
  if (project === null) return ok(snapshotRate(null));
  const id = validateId(project.id, 'project.id');
  if (!id.ok) return id;
  const rate = validateRateMinor(project.hourlyRateMinor, 'project.hourlyRateMinor');
  if (!rate.ok) return rate;
  const currency = validateCurrency(project.currency, 'project.currency');
  if (!currency.ok) return currency;
  return ok({ projectId: id.value, hourlyRateMinor: rate.value, currency: currency.value });
}

/**
 * Full check of an entry read from storage. Returns a fresh copy.
 * Checks: UUID id and projectId, integer timestamps, finished duration 60 000 to
 * 86 400 000 ms, note text, billable flag, rate, currency, and the projectless rule
 * (no project means rate null and USD). A running entry (endAt null) skips the
 * duration check; a start after nowMs is a clock change handled by recovery and stop.
 */
export function validateStoredEntry(entry: unknown, path = 'entry'): Result<TimeEntry> {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return fail('INVALID_ENTRY', `${path} must be an entry object.`, { field: path });
  }
  const e = entry as Record<string, unknown>;
  const id = validateId(e.id, `${path}.id`);
  if (!id.ok) return id;
  let projectId: string | null = null;
  if (e.projectId !== null) {
    const pid = validateId(e.projectId, `${path}.projectId`);
    if (!pid.ok) return pid;
    projectId = pid.value;
  }
  const start = validateTimestamp(e.startAt, `${path}.startAt`);
  if (!start.ok) return start;
  let endAt: number | null = null;
  if (e.endAt !== null) {
    const end = validateTimestamp(e.endAt, `${path}.endAt`);
    if (!end.ok) return end;
    const duration = end.value - start.value;
    const field = `${path}.endAt`;
    if (duration <= 0) return fail('ENTRY_END_NOT_AFTER_START', `${path} ends at or before its start.`, { field });
    if (duration < MIN_ENTRY_DURATION_MS) return fail('ENTRY_TOO_SHORT', `${path} lasts less than 1 minute.`, { field });
    if (duration > MAX_ENTRY_DURATION_MS) return fail('ENTRY_TOO_LONG', `${path} lasts more than 24 hours.`, { field });
    endAt = end.value;
  }
  if (typeof e.note !== 'string') return fail('INVALID_TEXT', `${path}.note must be text.`, { field: `${path}.note` });
  if (e.note.length > MAX_NOTE_LENGTH) {
    return fail('TEXT_TOO_LONG', `${path}.note cannot exceed ${MAX_NOTE_LENGTH} characters.`, { field: `${path}.note` });
  }
  const billable = validateBoolean(e.billable, `${path}.billable`);
  if (!billable.ok) return billable;
  const rate = validateRateMinor(e.hourlyRateMinor, `${path}.hourlyRateMinor`);
  if (!rate.ok) return rate;
  const currency = validateCurrency(e.currency, `${path}.currency`);
  if (!currency.ok) return currency;
  const snapshot = checkProjectlessSnapshot(projectId, rate.value, currency.value, path);
  if (!snapshot.ok) return snapshot;
  return ok({
    id: id.value,
    projectId,
    startAt: start.value,
    endAt,
    note: e.note,
    billable: billable.value,
    hourlyRateMinor: rate.value,
    currency: currency.value,
  });
}

/** Validates a list of stored entries. Errors name the index, for example entries[3].note. */
export function validateStoredEntries(entries: readonly unknown[], path = 'entries'): Result<readonly TimeEntry[]> {
  if (!Array.isArray(entries)) return fail('INVALID_ENTRY', `${path} must be a list of entries.`, { field: path });
  const result: TimeEntry[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const checked = validateStoredEntry(entries[i], `${path}[${i}]`);
    if (!checked.ok) return checked;
    result.push(checked.value);
  }
  return ok(result);
}

function checkProjectlessSnapshot(
  projectId: string | null,
  rate: number | null,
  currency: CurrencyCode,
  path: string,
): Result<true> {
  if (projectId === null && (rate !== null || currency !== DEFAULT_CURRENCY)) {
    return fail(
      'INVALID_PROJECTLESS_SNAPSHOT',
      `${path} has no project, so its rate must be null and its currency ${DEFAULT_CURRENCY}.`,
      { field: `${path}.hourlyRateMinor` },
    );
  }
  return ok(true);
}

/** Validates nowMs and every stored entry in the context. */
function validateContext(ctx: EntryContext): Result<true> {
  const now = validateTimestamp(ctx.nowMs, 'nowMs');
  if (!now.ok) return now;
  const entries = validateStoredEntries(ctx.entries, 'ctx.entries');
  if (!entries.ok) return entries;
  return ok(true);
}

/** Validates a finished interval: one minute to 24 hours inclusive. Future times allowed. */
export function validateFinishedRange(startAt: unknown, endAt: unknown): Result<Interval> {
  const start = validateTimestamp(startAt, 'startAt');
  if (!start.ok) return start;
  const end = validateTimestamp(endAt, 'endAt');
  if (!end.ok) return end;
  const duration = end.value - start.value;
  if (duration <= 0) {
    return fail('ENTRY_END_NOT_AFTER_START', 'The end time must be after the start time.', { field: 'endAt' });
  }
  if (duration < MIN_ENTRY_DURATION_MS) {
    return fail('ENTRY_TOO_SHORT', 'An entry must last at least 1 minute.', { field: 'endAt' });
  }
  if (duration > MAX_ENTRY_DURATION_MS) {
    return fail('ENTRY_TOO_LONG', 'An entry cannot last more than 24 hours.', { field: 'endAt' });
  }
  return ok({ startMs: start.value, endMs: end.value });
}

function validateRunningStart(startAt: unknown, ctx: EntryContext, excludeEntryId?: string): Result<number> {
  const start = validateTimestamp(startAt, 'startAt');
  if (!start.ok) return start;
  if (start.value > ctx.nowMs) {
    return fail('TIMER_START_IN_FUTURE', 'A running timer cannot start in the future.', { field: 'startAt' });
  }
  if (ctx.nowMs - start.value >= MAX_ENTRY_DURATION_MS) {
    return fail(
      'ENTRY_TOO_LONG',
      'A running timer cannot start 24 hours or more before now. Add a finished entry instead.',
      { field: 'startAt' },
    );
  }
  const otherRunning = [...ctx.entries]
    .sort(compareEntries)
    .find((e) => e.endAt === null && e.id !== excludeEntryId);
  if (otherRunning !== undefined) {
    return fail('TIMER_ALREADY_RUNNING', 'Another timer is already running. Stop it first.', {
      conflict: describeConflict(otherRunning, ctx),
    });
  }
  // [start, now] inclusive of now, so a finished entry that contains nowMs blocks the start.
  const conflict = findOverlappingEntry({ startMs: start.value, endMs: ctx.nowMs + 1 }, ctx, excludeEntryId);
  if (conflict !== null) return overlapFailure(conflict);
  return ok(start.value);
}

export interface ManualEntryInput {
  readonly id: string;
  readonly project: RateSource | null;
  readonly startAt: number;
  readonly endAt: number;
  readonly note?: string;
  /** Defaults to true. */
  readonly billable?: boolean;
}

/** Validates a new finished entry and snapshots the project's current rate and currency. */
export function prepareManualEntry(input: ManualEntryInput, ctx: EntryContext): Result<TimeEntry> {
  const valid = validateContext(ctx);
  if (!valid.ok) return valid;
  const id = validateId(input.id, 'id');
  if (!id.ok) return id;
  const snapshot = validateRateSource(input.project);
  if (!snapshot.ok) return snapshot;
  const note = normalizeNote(input.note);
  if (!note.ok) return note;
  const billable = validateBoolean(input.billable ?? true, 'billable');
  if (!billable.ok) return billable;
  const range = validateFinishedRange(input.startAt, input.endAt);
  if (!range.ok) return range;
  const conflict = findOverlappingEntry(range.value, ctx);
  if (conflict !== null) return overlapFailure(conflict);
  return ok({
    id: id.value,
    projectId: snapshot.value.projectId,
    startAt: range.value.startMs,
    endAt: range.value.endMs,
    note: note.value,
    billable: billable.value,
    hourlyRateMinor: snapshot.value.hourlyRateMinor,
    currency: snapshot.value.currency,
  });
}

export interface RateSnapshotOverride {
  readonly hourlyRateMinor: number | null;
  readonly currency: CurrencyCode;
}

export interface EntryChanges {
  readonly startAt?: number;
  /** Pass null to keep or make the entry running. Omit to keep the current end. */
  readonly endAt?: number | null;
  /**
   * Pass the entry's project (or null for "No project").
   * Same id as the entry's current project: the historical snapshot stays.
   * A different project: the entry takes that project's current rate and currency.
   * Omit to keep the project.
   */
  readonly project?: RateSource | null;
  /**
   * Explicit change of this entry's own rate and currency. Applied after `project`.
   * An entry without a project accepts only { hourlyRateMinor: null, currency: 'USD' }.
   */
  readonly rateSnapshot?: RateSnapshotOverride;
  readonly note?: string;
  readonly billable?: boolean;
}

function resolveEditSnapshot(existing: TimeEntry, changes: EntryChanges): Result<EntryRateSnapshot> {
  const kept: EntryRateSnapshot = {
    projectId: existing.projectId,
    hourlyRateMinor: existing.hourlyRateMinor,
    currency: existing.currency,
  };
  let snapshot: EntryRateSnapshot = kept;
  if (changes.project === null) {
    snapshot = existing.projectId === null ? kept : snapshotRate(null);
  } else if (changes.project !== undefined) {
    const id = validateId(changes.project.id, 'project.id');
    if (!id.ok) return id;
    if (id.value !== existing.projectId) {
      const fresh = validateRateSource(changes.project);
      if (!fresh.ok) return fresh;
      snapshot = fresh.value;
    }
  }
  if (changes.rateSnapshot !== undefined) {
    const rate = validateRateMinor(changes.rateSnapshot.hourlyRateMinor, 'rateSnapshot.hourlyRateMinor');
    if (!rate.ok) return rate;
    const currency = validateCurrency(changes.rateSnapshot.currency, 'rateSnapshot.currency');
    if (!currency.ok) return currency;
    const allowed = checkProjectlessSnapshot(snapshot.projectId, rate.value, currency.value, 'entry');
    if (!allowed.ok) return allowed;
    snapshot = { projectId: snapshot.projectId, hourlyRateMinor: rate.value, currency: currency.value };
  }
  return ok(snapshot);
}

/**
 * Validates an edit. Overlaps are checked against every entry except this one.
 * The rate snapshot changes only when the project changes or `rateSnapshot` is passed.
 */
export function prepareEntryEdit(existing: TimeEntry, changes: EntryChanges, ctx: EntryContext): Result<TimeEntry> {
  const valid = validateContext(ctx);
  if (!valid.ok) return valid;
  const stored = validateStoredEntry(existing, 'existing');
  if (!stored.ok) return stored;
  const startAt = changes.startAt ?? existing.startAt;
  const endAt = changes.endAt !== undefined ? changes.endAt : existing.endAt;

  let finalStart: number;
  if (endAt === null) {
    const start = validateRunningStart(startAt, ctx, existing.id);
    if (!start.ok) return start;
    finalStart = start.value;
  } else {
    const range = validateFinishedRange(startAt, endAt);
    if (!range.ok) return range;
    const conflict = findOverlappingEntry(range.value, ctx, existing.id);
    if (conflict !== null) return overlapFailure(conflict);
    finalStart = range.value.startMs;
  }

  const snapshot = resolveEditSnapshot(existing, changes);
  if (!snapshot.ok) return snapshot;
  const note = changes.note !== undefined ? normalizeNote(changes.note) : ok(existing.note);
  if (!note.ok) return note;
  const billable = validateBoolean(changes.billable ?? existing.billable, 'billable');
  if (!billable.ok) return billable;

  return ok({
    id: existing.id,
    projectId: snapshot.value.projectId,
    startAt: finalStart,
    endAt,
    note: note.value,
    billable: billable.value,
    hourlyRateMinor: snapshot.value.hourlyRateMinor,
    currency: snapshot.value.currency,
  });
}

/** Explicitly changes the rate and currency of one entry. Other fields stay. */
export function prepareEntryRateChange(
  existing: TimeEntry,
  rateSnapshot: RateSnapshotOverride,
  ctx: EntryContext,
): Result<TimeEntry> {
  return prepareEntryEdit(existing, { rateSnapshot }, ctx);
}

export interface TimerStartInput {
  readonly id: string;
  readonly project: RateSource | null;
  /** Defaults to nowMs. An earlier start is allowed; the whole elapsed interval is validated. */
  readonly startAt?: number;
  readonly note?: string;
  readonly billable?: boolean;
}

export interface TimerStartResult {
  readonly entry: TimeEntry;
  /** startAt + 24 h. The main process should stop the timer at this instant. */
  readonly autoCompleteAt: number;
  /** Start of the next future entry, if any. The timer will conflict with it if it runs that long. */
  readonly nextEntryStartAt: number | null;
}

export function prepareTimerStart(input: TimerStartInput, ctx: EntryContext): Result<TimerStartResult> {
  const valid = validateContext(ctx);
  if (!valid.ok) return valid;
  const id = validateId(input.id, 'id');
  if (!id.ok) return id;
  const snapshot = validateRateSource(input.project);
  if (!snapshot.ok) return snapshot;
  const note = normalizeNote(input.note);
  if (!note.ok) return note;
  const billable = validateBoolean(input.billable ?? true, 'billable');
  if (!billable.ok) return billable;
  const start = validateRunningStart(input.startAt ?? ctx.nowMs, ctx);
  if (!start.ok) return start;

  let nextEntryStartAt: number | null = null;
  for (const e of ctx.entries) {
    if (e.endAt !== null && e.startAt > ctx.nowMs && (nextEntryStartAt === null || e.startAt < nextEntryStartAt)) {
      nextEntryStartAt = e.startAt;
    }
  }
  return ok({
    entry: {
      id: id.value,
      projectId: snapshot.value.projectId,
      startAt: start.value,
      endAt: null,
      note: note.value,
      billable: billable.value,
      hourlyRateMinor: snapshot.value.hourlyRateMinor,
      currency: snapshot.value.currency,
    },
    autoCompleteAt: start.value + MAX_ENTRY_DURATION_MS,
    nextEntryStartAt,
  });
}

export type TimerStopOutcome =
  /** The timer ran under 60 seconds. Delete the entry. */
  | { readonly kind: 'delete-entry'; readonly entryId: string; readonly elapsedMs: number }
  /** Save `entry`. `capped` is true when elapsed time passed 24 h and the end was set to start + 24 h. */
  | {
      readonly kind: 'finish';
      readonly entry: TimeEntry;
      readonly elapsedMs: number;
      readonly durationMs: number;
      readonly capped: boolean;
    };

/**
 * Validates stopping the running entry at stopAt (default nowMs).
 * Never truncates at an overlap: an overlap returns ENTRY_OVERLAP.
 * A stop before the start returns CLOCK_CHANGED, not a delete outcome.
 */
export function stopTimer(entry: TimeEntry, ctx: EntryContext, stopAt?: number): Result<TimerStopOutcome> {
  const valid = validateContext(ctx);
  if (!valid.ok) return valid;
  const stored = validateStoredEntry(entry, 'entry');
  if (!stored.ok) return stored;
  if (entry.endAt !== null) return fail('TIMER_NOT_RUNNING', 'This entry is not running.');
  const stop = validateTimestamp(stopAt ?? ctx.nowMs, 'stopAt');
  if (!stop.ok) return stop;
  if (stop.value > ctx.nowMs) {
    return fail('TIMER_STOP_IN_FUTURE', 'A timer cannot stop in the future.', { field: 'stopAt' });
  }
  const elapsedMs = stop.value - entry.startAt;
  if (elapsedMs < 0) {
    return fail(
      'CLOCK_CHANGED',
      'The stop time is earlier than the start time. The system clock may have changed. Correct the start time, then stop the timer.',
      { field: 'startAt' },
    );
  }
  if (elapsedMs < MIN_ENTRY_DURATION_MS) {
    return ok({ kind: 'delete-entry', entryId: entry.id, elapsedMs });
  }
  const capped = elapsedMs > MAX_ENTRY_DURATION_MS;
  const endAt = capped ? entry.startAt + MAX_ENTRY_DURATION_MS : stop.value;
  const conflict = findOverlappingEntry({ startMs: entry.startAt, endMs: endAt }, ctx, entry.id);
  if (conflict !== null) return overlapFailure(conflict);
  return ok({ kind: 'finish', entry: { ...entry, endAt }, elapsedMs, durationMs: endAt - entry.startAt, capped });
}

export interface TimerStatus {
  readonly entryId: string;
  /** nowMs - startAt. Negative after a backward clock change. */
  readonly elapsedMs: number;
  readonly autoCompleteAt: number;
  readonly remainingMs: number;
  readonly clockChanged: boolean;
  readonly limitReached: boolean;
}

export function getTimerStatus(entry: TimeEntry, nowMs: number): TimerStatus {
  const elapsedMs = nowMs - entry.startAt;
  const autoCompleteAt = entry.startAt + MAX_ENTRY_DURATION_MS;
  return {
    entryId: entry.id,
    elapsedMs,
    autoCompleteAt,
    remainingMs: Math.max(0, autoCompleteAt - nowMs),
    clockChanged: elapsedMs < 0,
    limitReached: elapsedMs >= MAX_ENTRY_DURATION_MS,
  };
}

export type TimerRecovery =
  | { readonly kind: 'none' }
  /** The unique index should prevent this. Ask the user which timer to keep. */
  | { readonly kind: 'multiple-running'; readonly entryIds: readonly string[] }
  | { readonly kind: 'running'; readonly entry: TimeEntry; readonly status: TimerStatus }
  /** Elapsed time reached 24 h. Call stopTimer(entry, ctx, completeAt). */
  | { readonly kind: 'limit-reached'; readonly entry: TimeEntry; readonly status: TimerStatus; readonly completeAt: number }
  /** nowMs is before startAt. Ask the user to correct the start time. */
  | { readonly kind: 'clock-changed'; readonly entry: TimeEntry; readonly status: TimerStatus };

/** Finds the running entry after an app restart and classifies its state. No scheduling. */
export function recoverRunningTimer(entries: readonly TimeEntry[], nowMs: number): Result<TimerRecovery> {
  const now = validateTimestamp(nowMs, 'nowMs');
  if (!now.ok) return now;
  const stored = validateStoredEntries(entries, 'entries');
  if (!stored.ok) return stored;
  const running = stored.value.filter((e) => e.endAt === null);
  if (running.length === 0) return ok({ kind: 'none' });
  if (running.length > 1) {
    return ok({ kind: 'multiple-running', entryIds: running.map((e) => e.id).sort() });
  }
  const entry = running[0] as TimeEntry;
  const status = getTimerStatus(entry, nowMs);
  if (status.clockChanged) return ok({ kind: 'clock-changed', entry, status });
  if (status.limitReached) return ok({ kind: 'limit-reached', entry, status, completeAt: status.autoCompleteAt });
  return ok({ kind: 'running', entry, status });
}

