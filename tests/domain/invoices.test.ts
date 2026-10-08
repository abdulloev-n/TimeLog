import { describe, expect, it } from 'vitest';
import {
  buildInvoiceRow,
  formatInvoiceNumber,
  nextInvoiceSequence,
  normalizeInvoicePrefix,
  prepareInvoiceDraft,
  readInvoiceSnapshot,
  type InvoiceDraftInput,
  type ProjectInfo,
  type TimeEntry,
} from '../../src/domain/index.ts';
import { DAY, HOUR, MIN, T0, deepFreeze, makeEntry, uuid } from './fixtures.ts';

const CLIENT = uuid(301);
const OTHER_CLIENT = uuid(302);
const P1 = uuid(101);
const P2 = uuid(102);
const P_OTHER = uuid(103);
const D = T0 - 9 * HOUR;
const PERIOD = { startMs: D, endMs: D + 7 * DAY };

const projects: ProjectInfo[] = [
  { id: P1, name: 'Website', clientId: CLIENT, archived: false },
  { id: P2, name: 'Brand identity', clientId: CLIENT, archived: true },
  { id: P_OTHER, name: 'Other client work', clientId: OTHER_CLIENT, archived: false },
];

let counter = 0;
function e(fields: Partial<TimeEntry> & { startAt: number }): TimeEntry {
  counter += 1;
  return makeEntry({ id: uuid(counter), ...fields });
}

function input(entries: TimeEntry[], currency?: 'USD' | 'EUR'): InvoiceDraftInput {
  const base = {
    client: { id: CLIENT, name: 'Lumen Studio', email: 'billing@lumen.example', address: 'Istanbul' },
    sender: { name: 'Nazir', email: 'nazir@example.com', paymentDetails: 'IBAN TR00 0000' },
    period: PERIOD,
    entries,
    projects,
  };
  return deepFreeze(currency ? { ...base, currency } : base);
}

describe('prepareInvoiceDraft', () => {
  it('creates one line per project and rate snapshot', () => {
    const r = prepareInvoiceDraft(
      input([
        e({ startAt: D, endAt: D + HOUR, projectId: P1, hourlyRateMinor: 2000 }),
        e({ startAt: D + HOUR, endAt: D + 2 * HOUR, projectId: P1, hourlyRateMinor: 3000 }),
        e({ startAt: D + 2 * HOUR, endAt: D + 3 * HOUR, projectId: P1, hourlyRateMinor: 3000 }),
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.lines).toEqual([
      { projectId: P1, projectName: 'Website', durationMs: HOUR, hours: '1.00', hourlyRateMinor: 2000, currency: 'USD', amountMinor: 2000, entryCount: 1 },
      { projectId: P1, projectName: 'Website', durationMs: 2 * HOUR, hours: '2.00', hourlyRateMinor: 3000, currency: 'USD', amountMinor: 6000, entryCount: 2 },
    ]);
    expect(r.value.totalMinor).toBe(8000);
  });

  it('excludes running, nonbillable, unrated and other-client entries, but keeps archived projects', () => {
    const r = prepareInvoiceDraft(
      input([
        e({ startAt: D, endAt: D + HOUR, projectId: P2, hourlyRateMinor: 1000 }),
        e({ startAt: D + HOUR, endAt: D + 2 * HOUR, projectId: P1, hourlyRateMinor: 1000, billable: false }),
        e({ startAt: D + 2 * HOUR, endAt: D + 3 * HOUR, projectId: P1, hourlyRateMinor: null }),
        e({ startAt: D + 3 * HOUR, endAt: D + 4 * HOUR, projectId: P_OTHER, hourlyRateMinor: 1000 }),
        e({ startAt: D + 4 * HOUR, endAt: D + 5 * HOUR, hourlyRateMinor: null }),
        e({ startAt: D + 5 * HOUR, projectId: P1, hourlyRateMinor: 1000 }),
      ]),
    );
    expect(r.ok && r.value.lines.map((l) => [l.projectName, l.amountMinor])).toEqual([['Brand identity', 1000]]);
  });

  it('clips finished entries to the period', () => {
    const r = prepareInvoiceDraft(input([e({ startAt: D - HOUR, endAt: D + 30 * MIN, projectId: P1, hourlyRateMinor: 4000 })]));
    expect(r.ok && r.value.lines[0]).toMatchObject({ durationMs: 30 * MIN, hours: '0.50', amountMinor: 2000 });
  });

  it('rejects mixed currencies until one is chosen, then includes only that currency', () => {
    const entries = [
      e({ startAt: D, endAt: D + HOUR, projectId: P1, hourlyRateMinor: 1000, currency: 'USD' }),
      e({ startAt: D + HOUR, endAt: D + 2 * HOUR, projectId: P2, hourlyRateMinor: 2000, currency: 'EUR' }),
    ];
    const mixed = prepareInvoiceDraft(input(entries));
    expect(!mixed.ok && mixed.error.code).toBe('INVOICE_MIXED_CURRENCIES');
    expect(!mixed.ok && mixed.error.currencies).toEqual(['USD', 'EUR']);

    const eur = prepareInvoiceDraft(input(entries, 'EUR'));
    expect(eur.ok && eur.value.currency).toBe('EUR');
    expect(eur.ok && eur.value.lines.map((l) => [l.projectId, l.amountMinor])).toEqual([[P2, 2000]]);
    expect(eur.ok && eur.value.totalMinor).toBe(2000);
  });

  it('rejects a currency that no eligible entry uses', () => {
    const r = prepareInvoiceDraft(input([e({ startAt: D, endAt: D + HOUR, projectId: P1, hourlyRateMinor: 1000 })], 'EUR'));
    expect(!r.ok && r.error.code).toBe('INVOICE_CURRENCY_NOT_FOUND');
  });

  it('rejects a selection with no eligible entries', () => {
    const r = prepareInvoiceDraft(input([]));
    expect(!r.ok && r.error.code).toBe('INVOICE_NO_ELIGIBLE_ENTRIES');
  });

  it('calculates amounts from exact time, not from the displayed hours', () => {
    // 20 minutes at 30.00/h is exactly 10.00. Displayed hours 0.33 x 30.00 would read 9.90.
    const r = prepareInvoiceDraft(input([e({ startAt: D, endAt: D + 20 * MIN, projectId: P1, hourlyRateMinor: 3000 })]));
    expect(r.ok && r.value.lines[0]).toMatchObject({ hours: '0.33', amountMinor: 1000 });
  });
});

describe('invoice numbering and allocation', () => {
  it('formats numbers with prefix and padding', () => {
    expect(formatInvoiceNumber('INV-', 7)).toEqual({ ok: true, value: 'INV-0007' });
    expect(formatInvoiceNumber('', 42, 3)).toEqual({ ok: true, value: '042' });
    expect(formatInvoiceNumber('INV-', 12345)).toEqual({ ok: true, value: 'INV-12345' });
  });

  it('rejects bad sequence numbers and prefixes', () => {
    expect(formatInvoiceNumber('INV-', 0).ok).toBe(false);
    expect(formatInvoiceNumber('INV-', 1.5).ok).toBe(false);
    expect(normalizeInvoicePrefix('INV 2026').ok).toBe(false);
    expect(normalizeInvoicePrefix('X'.repeat(21)).ok).toBe(false);
    expect(normalizeInvoicePrefix('  NZ/2026-  ')).toEqual({ ok: true, value: 'NZ/2026-' });
  });

  it('allocates the next global sequence independent of the prefix', () => {
    expect(nextInvoiceSequence(null)).toEqual({ ok: true, value: 1 });
    expect(nextInvoiceSequence(41)).toEqual({ ok: true, value: 42 });
    expect(nextInvoiceSequence(0).ok).toBe(false);
  });

  it('builds an insertable row whose snapshot survives later edits to live records', () => {
    const entries = [e({ startAt: D, endAt: D + HOUR, projectId: P1, hourlyRateMinor: 5000 })];
    const draft = prepareInvoiceDraft(input(entries));
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const row = buildInvoiceRow(draft.value, { id: uuid(900), prefix: 'INV-', sequenceNumber: 3, issuedAt: T0 });
    expect(row.ok && row.value).toMatchObject({
      id: uuid(900),
      number: 'INV-0003',
      sequence_number: 3,
      client_id: CLIENT,
      period_start: PERIOD.startMs,
      period_end: PERIOD.endMs,
      currency: 'USD',
      total_minor: 5000,
      issued_at: T0,
    });
    if (!row.ok) return;

    // The live client and project change after issue. The stored snapshot does not.
    const renamedProjects = projects.map((p) => (p.id === P1 ? { ...p, name: 'Renamed' } : p));
    expect(renamedProjects[0]?.name).toBe('Renamed');
    const snapshot = readInvoiceSnapshot(row.value);
    expect(snapshot.ok && snapshot.value.lines[0]?.projectName).toBe('Website');
    expect(snapshot.ok && snapshot.value.client).toEqual({ id: CLIENT, name: 'Lumen Studio', email: 'billing@lumen.example', address: 'Istanbul' });
    expect(snapshot.ok && snapshot.value.sender).toEqual({ name: 'Nazir', address: null, email: 'nazir@example.com', paymentDetails: 'IBAN TR00 0000' });
  });

  it('reports a damaged snapshot', () => {
    const r = readInvoiceSnapshot({ currency: 'USD', lines_json: '{', sender_json: '{}', client_json: '{}' });
    expect(!r.ok && r.error.code).toBe('INVALID_INVOICE_SNAPSHOT');
  });
});

