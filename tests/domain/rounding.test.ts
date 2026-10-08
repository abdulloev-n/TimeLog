import { describe, expect, it } from 'vitest';
import { buildReport, groupEarnings, prepareInvoiceDraft, type ProjectInfo, type ReportEntry } from '../../src/domain/index.ts';
import { DAY, HOUR, MIN, T0, makeEntry, uuid } from './fixtures.ts';

const CLIENT = uuid(301);
const P1 = uuid(101);
const P2 = uuid(102);
const D = T0 - 9 * HOUR;
const PERIOD = { startMs: D, endMs: D + 7 * DAY };
const projects: ProjectInfo[] = [
  { id: P1, name: 'Website', clientId: CLIENT, archived: false },
  { id: P2, name: 'Brand', clientId: CLIENT, archived: false },
];
const client = { id: CLIENT, name: 'Lumen Studio', email: null, address: null };
const sender = { name: 'Nazir' };

function entry(n: number, fields: Partial<ReportEntry> & { startAt: number }): ReportEntry {
  return { ...makeEntry({ id: uuid(n), ...fields }), tagIds: [] };
}

function totals(entries: ReportEntry[]) {
  const report = buildReport({ period: PERIOD, entries, projects, tags: [], nowMs: D + 8 * DAY });
  const invoice = prepareInvoiceDraft({ client, sender, period: PERIOD, entries, projects });
  if (!report.ok) throw new Error(report.error.message);
  if (!invoice.ok) throw new Error(invoice.error.message);
  return { report: report.value, invoice: invoice.value };
}

describe('one rounding rule for reports and invoices', () => {
  it('rounds each projectId + currency + rate group, then sums: 1 min at 0.30/h and 1 min at 0.90/h', () => {
    // 1 min at 30 cents/h = 0.5 cent -> 1. 1 min at 90 cents/h = 1.5 cents -> 2. Total 3.
    // Rounding the whole project at once would give (0.5 + 1.5) = 2 cents.
    const entries = [
      entry(1, { startAt: D, endAt: D + MIN, projectId: P1, hourlyRateMinor: 30 }),
      entry(2, { startAt: D + HOUR, endAt: D + HOUR + MIN, projectId: P1, hourlyRateMinor: 90 }),
    ];
    const { report, invoice } = totals(entries);

    expect(invoice.lines.map((l) => [l.hourlyRateMinor, l.amountMinor])).toEqual([
      [30, 1],
      [90, 2],
    ]);
    expect(invoice.totalMinor).toBe(3);

    expect(report.byProject[0]?.rateSnapshots.map((r) => [r.hourlyRateMinor, r.amountMinor])).toEqual([
      [30, 1],
      [90, 2],
    ]);
    expect(report.byProject[0]?.earnings).toEqual([{ currency: 'USD', billableMs: 2 * MIN, ratedBillableMs: 2 * MIN, amountMinor: 3 }]);
    expect(report.totalsByCurrency).toEqual([{ currency: 'USD', billableMs: 2 * MIN, ratedBillableMs: 2 * MIN, amountMinor: 3 }]);
    expect(report.totalsByCurrency[0]?.amountMinor).toBe(invoice.totalMinor);
  });

  it('matches across several projects and rates in one period', () => {
    // Website: 1 min at 25.50 (42.5 -> 43) + 1 min at 25.50 in the same group (85 total, one rounding),
    // Website: 10 min at 10.00 (166.67 -> 167). Brand: 7 min at 33.33 (388.85 -> 389). Total 85 + 167 + 389 = 641.
    const entries = [
      entry(1, { startAt: D, endAt: D + MIN, projectId: P1, hourlyRateMinor: 2550 }),
      entry(2, { startAt: D + MIN, endAt: D + 2 * MIN, projectId: P1, hourlyRateMinor: 2550 }),
      entry(3, { startAt: D + HOUR, endAt: D + HOUR + 10 * MIN, projectId: P1, hourlyRateMinor: 1000 }),
      entry(4, { startAt: D + 2 * HOUR, endAt: D + 2 * HOUR + 7 * MIN, projectId: P2, hourlyRateMinor: 3333 }),
    ];
    const { report, invoice } = totals(entries);
    expect(invoice.totalMinor).toBe(641);
    expect(report.totalsByCurrency[0]?.amountMinor).toBe(641);
    const reportLines = report.byProject.flatMap((p) => p.rateSnapshots.map((r) => r.amountMinor)).sort((a, b) => a - b);
    const invoiceLines = invoice.lines.map((l) => l.amountMinor).sort((a, b) => a - b);
    expect(reportLines).toEqual(invoiceLines);
    expect(invoiceLines).toEqual([85, 167, 389]);
  });

  it('groupEarnings keeps projects, currencies and rates apart', () => {
    const r = groupEarnings([
      { projectId: P1, currency: 'USD', hourlyRateMinor: 30, durationMs: MIN },
      { projectId: P1, currency: 'USD', hourlyRateMinor: 30, durationMs: MIN },
      { projectId: P1, currency: 'EUR', hourlyRateMinor: 30, durationMs: MIN },
      { projectId: P2, currency: 'USD', hourlyRateMinor: 30, durationMs: MIN },
    ]);
    expect(r.ok && r.value.map((g) => [g.projectId, g.currency, g.durationMs, g.segmentCount, g.amountMinor])).toEqual([
      [P1, 'USD', 2 * MIN, 2, 1],
      [P1, 'EUR', MIN, 1, 1],
      [P2, 'USD', MIN, 1, 1],
    ]);
  });
});

