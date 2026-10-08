# TimeLog domain library: integration guide

This package holds the pure business rules of TimeLog: types, validation, time math, earnings, reports, invoice snapshots and archiving decisions. It has no runtime dependencies. It never calls `Date.now()`, never touches the filesystem or a database, and never mutates its inputs.

## Contents

```
src/domain/
  index.ts         public API (re-exports everything below)
  result.ts        Result<T>, error codes, EntryConflict
  currency.ts      supported currencies and metadata
  validation.ts    ids, timestamps, names, rates, constants
  money.ts         rate parsing, rounding, formatting
  earnings.ts      the single rounding rule for reports and invoices
  entities.ts      clients, projects, tags
  entries.ts       manual entries, edits, timer start/stop, recovery
  periods.ts       clipping, day splitting, goals
  reports.ts       report aggregation
  invoices.ts      invoice draft, numbering, rows, snapshot reading
  archiving.ts     delete-or-archive decisions, tag link removal
src/database/migrations/
  001_initial_schema.sql
  002_invoice_immutability.sql
tests/domain/
  *.test.ts                Vitest suites
  fixtures.ts, tsconfig.json
  verify-migrations.mjs    migration checks against real SQLite (sql.js)
```

## Running the tests

The root `package.json` already includes the domain dependencies and scripts:

```
npm install
npm run typecheck
npm test
npm run verify:migrations
```

`verify:migrations` applies every `src/database/migrations/NNN_*.sql` file in order to an in-memory sql.js database with foreign keys on, then runs 47 constraint checks (durations, the running-timer index, currencies, tag case, restrict and cascade rules, invoice uniqueness and immutability). It prints PASS or FAIL per check and exits with code 1 on any failure.

The code compiles under `strict` and `noUncheckedIndexedAccess`, target ES2022 (it uses `BigInt`). Imports are extensionless, so use `moduleResolution: "Bundler"` or a bundler (Vite) for the Electron main process.

## Conventions

| Topic | Rule |
| --- | --- |
| Ids | UUID v4 strings from `crypto.randomUUID()` in the main process. |
| Time | INTEGER epoch milliseconds, UTC instants, nonnegative. Display in local time. |
| Current time | Every function that needs it takes `nowMs`. |
| Money | INTEGER minor units. USD 25.50 is `2550`. All ten currencies use two decimals. |
| Booleans in SQL | `0` / `1`. Map to `boolean` when you read rows. |
| Results | Expected failures return `{ ok: false, error: { code, message, field?, conflict?, currencies? } }`. Switch on `code`; show `message`. |
| Entry fields | UI "Description" is `note`. "Date" is derived from `startAt` in local time. "Duration" is `endAt - startAt`, or `nowMs - startAt` while running. |

## Stored entries

Every function that receives entries from the database runs `validateStoredEntry` on each one first: `prepareManualEntry`, `prepareEntryEdit`, `prepareTimerStart`, `stopTimer` (context entries and the entry itself), `recoverRunningTimer`, `splitEntriesByDays`, `calculatePeriodTotal`, the goal helpers, `buildReport` (also `tagIds`) and `prepareInvoiceDraft`. An invalid row returns an error whose `field` names it, for example `ctx.entries[3].billable` or `entries[0].endAt`.

The check covers: UUID v4 `id`; `projectId` null or UUID v4; integer timestamps; finished duration 60 000 to 86 400 000 ms; `note` is text up to 2 000 characters; `billable` is a boolean (map SQL 0/1 before calling); rate null or a nonnegative integer; supported currency; an entry without a project has rate null and USD.

A running entry (`endAt === null`) skips the duration check. A start after `nowMs` after the system clock moved back is valid data; `recoverRunningTimer` returns `clock-changed` and `stopTimer` returns `CLOCK_CHANGED`.

Low-level helpers (`findOverlappingEntry`, `clipEntryToPeriod`, `getTimerStatus`, `groupEarnings`, `intervalsOverlap`) do not validate. Call them with checked data, or use the functions above.

## Migrations

Run in numeric order, each in its own transaction, then record the version:

```ts
db.run('PRAGMA foreign_keys = ON'); // every time the database opens
const applied = new Set(
  (db.exec('SELECT version FROM schema_migrations')[0]?.values ?? []).map((r) => Number(r[0])),
); // guard: the table does not exist before migration 1
for (const { version, sql } of migrations) {          // [{1, 001...}, {2, 002...}]
  if (applied.has(version)) continue;
  db.run('BEGIN');
  try {
    db.run(sql);
    db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [version, Date.now()]);
    db.run('COMMIT');
  } catch (e) { db.run('ROLLBACK'); throw e; }
}
```

Check whether `schema_migrations` exists (`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`) before reading it on a fresh database.

What the schema enforces:

- Foreign keys: `ON DELETE RESTRICT` toward clients and projects, `ON DELETE CASCADE` on `entry_tags`.
- One running timer: `one_running_entry` partial unique index.
- Finished entries last 60 000 to 86 400 000 ms (this also forces `end_at > start_at`).
- Entries without a project have `hourly_rate_minor IS NULL` and `currency = 'USD'`.
- Allowed currency codes, nonnegative integer rates, 0/1 booleans, integer timestamps.
- Unique `invoices.number` and `invoices.sequence_number`; `period_end > period_start`.
- Migration 002 adds triggers that abort any UPDATE or DELETE on `invoices`.

The schema does not validate JSON content (`json_valid`), email format or UUID shape beyond length 36. The domain layer does that.

## Clients and projects

```ts
const client = prepareClient({ id: crypto.randomUUID(), name, email, address, currency, createdAt: Date.now() });
// Prefill the project form with the client's currency:
const suggested = suggestProjectCurrency(client.ok ? client.value : null);
const rate = parseRateInput(rateFieldText);            // "25,50" -> 2550
const project = prepareProject({ id: crypto.randomUUID(), name, clientId, hourlyRateMinor: rate.ok ? rate.value : null, currency: suggested, createdAt: Date.now() });
const edited = updateProject(existingProject, { hourlyRateMinor: 4000 }); // new entries only
```

## Entries and the timer

Load every entry before a validation call. The functions check overlaps against the whole list.

```ts
const ctx = { entries: allEntries, nowMs: Date.now(), projectNames: { [projectId]: 'Website' } };

// Manual entry
const r = prepareManualEntry({ id: crypto.randomUUID(), project, startAt, endAt, note, billable: true }, ctx);
if (!r.ok && r.error.code === 'ENTRY_OVERLAP') showConflict(r.error.conflict); // entryId, label, times

// Start
const s = prepareTimerStart({ id: crypto.randomUUID(), project, note }, ctx);
if (s.ok) { insert(s.value.entry); scheduleAutoStop(s.value.autoCompleteAt); }

// Stop
const stop = stopTimer(runningEntry, { ...ctx, nowMs: Date.now() });
if (stop.ok && stop.value.kind === 'delete-entry') deleteEntry(stop.value.entryId);   // under 60 s
if (stop.ok && stop.value.kind === 'finish') updateEntry(stop.value.entry);           // capped flag tells the UI
if (!stop.ok && stop.error.code === 'CLOCK_CHANGED') askUserToCorrectStart();
```

Rules the functions apply:

- Intervals are `[start, end)`. An entry may end exactly when another starts.
- A running timer ends at `nowMs` during overlap checks.
- A timer start at `nowMs` is rejected when a finished entry contains `nowMs`, or starts at `nowMs`. An earlier start validates the whole elapsed interval.
- A running timer cannot start in the future or 24 hours (or more) ago.
- Stopping re-checks overlaps. On conflict the result is `ENTRY_OVERLAP`. Nothing is truncated.
- Elapsed over 24 h finishes at `startAt + 24 h` with `capped: true`.
- Editing excludes the edited entry from overlap checks.

### Rate snapshots

`prepareManualEntry` and `prepareTimerStart` copy `hourlyRateMinor` and `currency` from the project. Changing a project's rate later does not change existing entries.

`prepareEntryEdit` changes the snapshot in two cases only:

| `changes` | Result |
| --- | --- |
| `project` omitted | Snapshot kept. |
| `project` with the same id as `existing.projectId` | Snapshot kept, even if the project's rate changed since. The edit form can always pass the selected project. |
| `project` with a different id | New snapshot from that project. |
| `project: null` | Snapshot becomes null rate and USD. |
| `rateSnapshot: { hourlyRateMinor, currency }` | Explicit change of this entry only. Applied after `project`. Without a project only `{ null, 'USD' }` passes (`INVALID_PROJECTLESS_SNAPSHOT`). |

```ts
// Save an old entry with a new description: rate stays as recorded.
prepareEntryEdit(entry, { project: currentProject, note: 'Second round' }, ctx);
// Change the rate of this one entry on purpose.
prepareEntryRateChange(entry, { hourlyRateMinor: 4000, currency: 'EUR' }, ctx);
```

### Recovery after restart

```ts
const rec = recoverRunningTimer(allEntries, Date.now());
switch (rec.ok && rec.value.kind) {
  case 'running':       scheduleAutoStop(rec.value.status.autoCompleteAt); break;
  case 'limit-reached': stopTimer(rec.value.entry, ctx, rec.value.completeAt); break; // finishes at 24 h
  case 'clock-changed': askUserToCorrectStart(rec.value.entry); break;
  case 'multiple-running': askUserWhichToKeep(rec.value.entryIds); break;
}
```

Scheduling (`setTimeout`, power events) belongs to the main process.

## Days, periods and goals

You compute local midnights; the library never assumes a day lasts 24 hours.

```ts
const dayStart = (y: number, m: number, d: number) => new Date(y, m, d).getTime(); // local midnight
const days = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ startMs: dayStart(y, m, d + i), endMs: dayStart(y, m, d + i + 1) }));
const split = splitEntriesByDays(allEntries, days, Date.now());     // segments keep entryId
const daily = calculateDailyGoalProgress(allEntries, days[0], 8 * 3_600_000, Date.now());
// daily.value.ringFraction is clamped to 0..1; fraction and percent may exceed 1 and 100.
// A goal of 0 returns hasGoal: false, fraction: null, ringFraction: 0.
```

## Reports

```ts
const report = buildReport({ period, days, entries: entriesWithTagIds, projects, tags, nowMs: Date.now() });
```

- Entries are clipped to the period first. Running entries count up to `nowMs`.
- Earnings use each entry's own rate snapshot. Nonbillable entries add hours, not money. Entries without a rate add to `unratedBillableMs`.
- Rounding follows the rule in "Rounding" below. Currencies are never added together or converted.
- `rateSnapshots` lists each distinct rate/currency in a project, with `hasMultipleRates` and `hasMultipleCurrencies`. Each row's `amountMinor` is its rounded group, so the rows add up to the project amount.
- `byTag` counts an entry toward each of its tags, so the tag sum can exceed `totalMs`.
- Pass archived projects in `projects` so historical rows keep their names.

## Rounding

Reports and invoices share one rule, implemented once in `earnings.ts` (`groupEarnings`, `sumGroupAmounts`):

1. Clip each billable, rated entry to the period.
2. Group the clipped time by `projectId + currency + hourlyRateMinor`.
3. Round each group once: exact milliseconds x rate / 3 600 000, half up, in BigInt.
4. Add the rounded group amounts per currency.

An invoice line is one such group, and a report rate row is the same group, so for the same entries and period the invoice total equals the report total for that client and currency. Example: one project in USD, 1 minute at 0.30/h and 1 minute at 0.90/h. The groups are 0.5 cent and 1.5 cents, rounded to 1 and 2, total 3 cents in both the report and the invoice. Rounding the project as a whole would give 2 cents; the library never does that.

Entries in the same group are not rounded one by one: two 1-minute entries at 25.50/h give 85 cents, not 43 + 43.

## Invoices

```ts
const draft = prepareInvoiceDraft({ client, sender, period, entries: allEntries, projects: allProjects, currency });
if (!draft.ok && draft.error.code === 'INVOICE_MIXED_CURRENCIES') askForCurrency(draft.error.currencies);
```

Eligible entries: finished, billable, with a rate, on a project of this client (archived included), clipped to the period. One line per project and rate (a rounding group, see "Rounding"). Hours show two decimals; amounts come from exact milliseconds. A reader multiplying the displayed hours by the rate can get a slightly different figure (20 min at 30.00 shows 0.33 h and 10.00, while 0.33 x 30.00 reads 9.90).

### Allocation contract

The main process allocates the number and inserts the complete snapshot in one transaction:

```ts
db.run('BEGIN IMMEDIATE');
try {
  const max = db.exec('SELECT MAX(sequence_number) FROM invoices')[0]?.values[0]?.[0] ?? null;
  const seq = nextInvoiceSequence(max === null ? null : Number(max));
  const row = buildInvoiceRow(draft.value, { id: crypto.randomUUID(), prefix: settings.invoicePrefix, sequenceNumber: seq.value, issuedAt: Date.now() });
  db.run('INSERT INTO invoices (id, number, sequence_number, client_id, period_start, period_end, currency, total_minor, lines_json, sender_json, client_json, issued_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [row.value.id, row.value.number, row.value.sequence_number, row.value.client_id, row.value.period_start, row.value.period_end, row.value.currency, row.value.total_minor, row.value.lines_json, row.value.sender_json, row.value.client_json, row.value.issued_at]);
  db.run('COMMIT');
} catch (e) { db.run('ROLLBACK'); throw e; }
// Then persist the database file and generate the PDF.
```

- The sequence is global and independent of the prefix.
- Once the row exists, its number stays reserved, even if the user cancels the PDF dialog.
- "Save PDF again" reads the row with `readInvoiceSnapshot(row)` and never the live client, project or settings records.
- A prefix change can in theory produce an existing number (prefix `A1` + 23 vs prefix `A` + 10023 at padding 4). The UNIQUE constraint rejects the insert; show the error and ask for another prefix.
- The domain API has no edit or delete for invoices, and migration 002 blocks both in SQL.

## Archiving and deletion

```ts
const d = decideProjectRemoval({ project, entryReferenceCount });         // SELECT COUNT(*) FROM time_entries WHERE project_id = ?
const c = decideClientRemoval({ client, projects: allProjects, invoiceReferenceCount }); // COUNT invoices for client
// action: 'delete-after-confirmation' | 'archive' | 'already-archived'
// For clients, activeProjects lists projects the UI can offer to archive too.
const archived = setArchived(project, true); // copy
```

`linksAfterEntryDeletion` and `linksAfterTagDeletion` mirror the cascade so the UI can update its state without reloading.

## Error codes

| Code | Meaning |
| --- | --- |
| INVALID_ID, INVALID_TIMESTAMP, INVALID_NUMBER, INVALID_BOOLEAN, INVALID_TEXT | Wrong type or shape. |
| INVALID_ENTRY | A stored entry (or list of entries, or tagIds) is not the expected shape. |
| INVALID_PROJECTLESS_SNAPSHOT | An entry without a project carries a rate or a currency other than USD. |
| EMPTY_NAME, TEXT_TOO_LONG, INVALID_EMAIL | Text rules. |
| UNSUPPORTED_CURRENCY, INVALID_RATE, NEGATIVE_RATE | Currency and stored rate rules. |
| RATE_INPUT_EMPTY, RATE_INPUT_NEGATIVE, RATE_INPUT_INVALID_FORMAT, RATE_INPUT_AMBIGUOUS, RATE_INPUT_TOO_MANY_DECIMALS | Rate field parsing. |
| AMOUNT_OUT_OF_RANGE | Amount above Number.MAX_SAFE_INTEGER minor units. |
| ENTRY_END_NOT_AFTER_START, ENTRY_TOO_SHORT, ENTRY_TOO_LONG | Duration rules. |
| ENTRY_OVERLAP | Includes `conflict`. |
| TIMER_ALREADY_RUNNING, TIMER_START_IN_FUTURE, TIMER_NOT_RUNNING, TIMER_STOP_IN_FUTURE, CLOCK_CHANGED | Timer rules. |
| INVALID_PERIOD, PERIODS_OVERLAP, PERIOD_OUTSIDE_RANGE, INVALID_GOAL | Period and goal input. |
| DUPLICATE_TAG_NAME | ASCII case-insensitive tag clash. |
| INVOICE_NO_ELIGIBLE_ENTRIES, INVOICE_MIXED_CURRENCIES, INVOICE_CURRENCY_NOT_FOUND | Invoice selection. `currencies` lists the options. |
| INVALID_INVOICE_PREFIX, INVALID_INVOICE_SEQUENCE, INVALID_INVOICE_SNAPSHOT | Numbering and stored snapshot. |

## Known limitations

- Tag uniqueness folds ASCII A-Z only, in SQL (NOCASE) and in `findTagNameConflict`. "Étude" and "étude" count as different tags.
- Symbols for TJS ("SM"), CHF and AED use Latin text so they render in any font.
- Timestamps before 1970 are rejected.
- A running entry whose start lies after `nowMs` (backward clock change) has an empty interval and blocks nothing in overlap checks until the user corrects it.
- Editing a running timer that already passed 24 hours returns `ENTRY_TOO_LONG`. Stop it first (recovery returns `limit-reached`).
- `buildReport` and `prepareInvoiceDraft` check each stored entry but do not check entries against each other for overlaps. The validation functions keep stored data free of overlaps.
- Changing a project's rate does not touch existing entries. Moving an entry to a different project takes that project's current rate; keeping the same project keeps the recorded rate.
