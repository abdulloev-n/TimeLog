import { compareCurrencies, type CurrencyCode } from './currency.ts';
import { groupEarnings, earningsGroupKey, sumGroupAmounts, type EarningsSegment } from './earnings.ts';
import { asciiCaseFold, type ProjectInfo, type Tag } from './entities.ts';
import { validateStoredEntry, type TimeEntry } from './entries.ts';
import { clipEntryToPeriod, splitEntriesByDays, validateDayPeriods, validatePeriod, type Period } from './periods.ts';
import { fail, ok, type Result } from './result.ts';
import { validateId, validateTimestamp } from './validation.ts';

export const NO_PROJECT_LABEL = 'No project';
export const UNKNOWN_PROJECT_LABEL = 'Unknown project';
export const UNKNOWN_TAG_LABEL = 'Unknown tag';

export interface ReportEntry extends TimeEntry {
  readonly tagIds: readonly string[];
}

export interface ReportInput {
  readonly period: Period;
  /** Optional local day periods inside `period`, for the by-day chart. */
  readonly days?: readonly Period[];
  readonly entries: readonly ReportEntry[];
  /** Include archived projects so historical rows keep their names. */
  readonly projects: readonly ProjectInfo[];
  readonly tags: readonly Tag[];
  readonly nowMs: number;
}

export interface CurrencyAmount {
  readonly currency: CurrencyCode;
  readonly billableMs: number;
  /** Billable time that had a rate. */
  readonly ratedBillableMs: number;
  /** Sum of rounded projectId + currency + rate groups. */
  readonly amountMinor: number;
}

export interface RateSnapshotSummary {
  readonly hourlyRateMinor: number | null;
  readonly currency: CurrencyCode;
  readonly durationMs: number;
  readonly billableMs: number;
  /** The rounded projectId + currency + rate group. 0 for null rates. Rows add up to the project amount. */
  readonly amountMinor: number;
}

export interface ProjectReportRow {
  /** Null for the "No project" group. */
  readonly projectId: string | null;
  readonly projectName: string;
  readonly archived: boolean;
  readonly durationMs: number;
  readonly billableMs: number;
  readonly nonBillableMs: number;
  readonly unratedBillableMs: number;
  /** One row per currency. */
  readonly earnings: readonly CurrencyAmount[];
  /** Every distinct rate/currency snapshot seen in this project during the period. */
  readonly rateSnapshots: readonly RateSnapshotSummary[];
  readonly hasMultipleRates: boolean;
  readonly hasMultipleCurrencies: boolean;
}

export interface TagReportRow {
  readonly tagId: string;
  readonly tagName: string;
  readonly durationMs: number;
}

export interface DayTotal {
  readonly period: Period;
  readonly durationMs: number;
}

export interface Report {
  readonly period: Period;
  readonly totalMs: number;
  readonly billableMs: number;
  readonly byDay: readonly DayTotal[];
  readonly byProject: readonly ProjectReportRow[];
  /** Sum of rounded groups per currency. Matches an invoice for the same entries. Currencies never mix. */
  readonly totalsByCurrency: readonly CurrencyAmount[];
  /** An entry with several tags counts toward each. The sum can exceed totalMs. */
  readonly byTag: readonly TagReportRow[];
  readonly untaggedMs: number;
}

interface CurrencyAcc {
  billableMs: number;
  ratedBillableMs: number;
}

interface RateAcc {
  hourlyRateMinor: number | null;
  currency: CurrencyCode;
  durationMs: number;
  billableMs: number;
}

interface ProjectAcc {
  projectId: string | null;
  durationMs: number;
  billableMs: number;
  unratedBillableMs: number;
  currencies: Map<CurrencyCode, CurrencyAcc>;
  rates: Map<string, RateAcc>;
}

const NO_PROJECT_KEY = '';

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validateReportEntries(entries: readonly ReportEntry[]): Result<readonly ReportEntry[]> {
  if (!Array.isArray(entries)) return fail('INVALID_ENTRY', 'entries must be a list of entries.', { field: 'entries' });
  const result: ReportEntry[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const raw = entries[i] as ReportEntry;
    const entry = validateStoredEntry(raw, `entries[${i}]`);
    if (!entry.ok) return entry;
    if (!Array.isArray(raw.tagIds)) {
      return fail('INVALID_ENTRY', `entries[${i}].tagIds must be a list of tag ids.`, { field: `entries[${i}].tagIds` });
    }
    for (let t = 0; t < raw.tagIds.length; t += 1) {
      const tagId = validateId(raw.tagIds[t], `entries[${i}].tagIds[${t}]`);
      if (!tagId.ok) return tagId;
    }
    result.push({ ...entry.value, tagIds: [...raw.tagIds] });
  }
  return ok(result);
}

export function buildReport(input: ReportInput): Result<Report> {
  const now = validateTimestamp(input.nowMs, 'nowMs');
  if (!now.ok) return now;
  const period = validatePeriod(input.period, 'period');
  if (!period.ok) return period;
  const checked = validateReportEntries(input.entries);
  if (!checked.ok) return checked;
  const entries = checked.value;

  let byDay: DayTotal[] = [];
  if (input.days !== undefined) {
    const days = validateDayPeriods(input.days);
    if (!days.ok) return days;
    for (const day of days.value) {
      if (day.startMs < period.value.startMs || day.endMs > period.value.endMs) {
        return fail('PERIOD_OUTSIDE_RANGE', 'Each day period must lie inside the report period.', { field: 'days' });
      }
    }
    const split = splitEntriesByDays(entries, days.value, now.value);
    if (!split.ok) return split;
    byDay = split.value.map((d) => ({ period: d.period, durationMs: d.totalMs }));
  }

  const projectsById = new Map(input.projects.map((p) => [p.id, p] as const));
  const tagsById = new Map(input.tags.map((t) => [t.id, t] as const));
  const accs = new Map<string, ProjectAcc>();
  const tagTotals = new Map<string, number>();
  const earningSegments: EarningsSegment[] = [];
  let totalMs = 0;
  let billableMs = 0;
  let untaggedMs = 0;

  for (const entry of entries) {
    const segment = clipEntryToPeriod(entry, period.value, now.value);
    if (segment === null) continue;
    const d = segment.durationMs;
    totalMs += d;

    const key = entry.projectId ?? NO_PROJECT_KEY;
    let acc = accs.get(key);
    if (acc === undefined) {
      acc = { projectId: entry.projectId, durationMs: 0, billableMs: 0, unratedBillableMs: 0, currencies: new Map(), rates: new Map() };
      accs.set(key, acc);
    }
    acc.durationMs += d;

    const rateKey = `${entry.hourlyRateMinor ?? 'none'}|${entry.currency}`;
    let rate = acc.rates.get(rateKey);
    if (rate === undefined) {
      rate = { hourlyRateMinor: entry.hourlyRateMinor, currency: entry.currency, durationMs: 0, billableMs: 0 };
      acc.rates.set(rateKey, rate);
    }
    rate.durationMs += d;

    if (entry.billable) {
      billableMs += d;
      acc.billableMs += d;
      rate.billableMs += d;
      let cur = acc.currencies.get(entry.currency);
      if (cur === undefined) {
        cur = { billableMs: 0, ratedBillableMs: 0 };
        acc.currencies.set(entry.currency, cur);
      }
      cur.billableMs += d;
      if (entry.hourlyRateMinor !== null) {
        cur.ratedBillableMs += d;
        earningSegments.push({
          projectId: entry.projectId,
          currency: entry.currency,
          hourlyRateMinor: entry.hourlyRateMinor,
          durationMs: d,
        });
      } else {
        acc.unratedBillableMs += d;
      }
    }

    const uniqueTags = [...new Set(entry.tagIds)];
    if (uniqueTags.length === 0) untaggedMs += d;
    for (const tagId of uniqueTags) tagTotals.set(tagId, (tagTotals.get(tagId) ?? 0) + d);
  }

  const grouped = groupEarnings(earningSegments);
  if (!grouped.ok) return grouped;
  const groupAmount = new Map(grouped.value.map((g) => [earningsGroupKey(g.projectId, g.currency, g.hourlyRateMinor), g.amountMinor] as const));

  const rows: ProjectReportRow[] = [];
  const currencyTotals = new Map<CurrencyCode, { billableMs: number; ratedBillableMs: number; amountMinor: number }>();

  for (const acc of accs.values()) {
    const earnings: CurrencyAmount[] = [];
    const sortedCurrencies = [...acc.currencies.entries()].sort((a, b) => compareCurrencies(a[0], b[0]));
    for (const [currency, c] of sortedCurrencies) {
      const amount = sumGroupAmounts(
        grouped.value.filter((g) => g.projectId === acc.projectId && g.currency === currency),
      );
      if (!amount.ok) return amount;
      earnings.push({ currency, billableMs: c.billableMs, ratedBillableMs: c.ratedBillableMs, amountMinor: amount.value });
      const total = currencyTotals.get(currency) ?? { billableMs: 0, ratedBillableMs: 0, amountMinor: 0 };
      const sum = sumGroupAmounts([{ amountMinor: total.amountMinor }, { amountMinor: amount.value }]);
      if (!sum.ok) return sum;
      currencyTotals.set(currency, {
        billableMs: total.billableMs + c.billableMs,
        ratedBillableMs: total.ratedBillableMs + c.ratedBillableMs,
        amountMinor: sum.value,
      });
    }

    const rateSnapshots: RateSnapshotSummary[] = [...acc.rates.values()]
      .sort((a, b) => {
        const byCurrency = compareCurrencies(a.currency, b.currency);
        if (byCurrency !== 0) return byCurrency;
        return (a.hourlyRateMinor ?? -1) - (b.hourlyRateMinor ?? -1);
      })
      .map((r) => ({
        hourlyRateMinor: r.hourlyRateMinor,
        currency: r.currency,
        durationMs: r.durationMs,
        billableMs: r.billableMs,
        amountMinor:
          r.hourlyRateMinor === null
            ? 0
            : (groupAmount.get(earningsGroupKey(acc.projectId, r.currency, r.hourlyRateMinor)) ?? 0),
      }));

    const project = acc.projectId === null ? undefined : projectsById.get(acc.projectId);
    const projectName = acc.projectId === null ? NO_PROJECT_LABEL : (project?.name ?? UNKNOWN_PROJECT_LABEL);
    rows.push({
      projectId: acc.projectId,
      projectName,
      archived: project?.archived ?? false,
      durationMs: acc.durationMs,
      billableMs: acc.billableMs,
      nonBillableMs: acc.durationMs - acc.billableMs,
      unratedBillableMs: acc.unratedBillableMs,
      earnings,
      rateSnapshots,
      hasMultipleRates: rateSnapshots.length > 1,
      hasMultipleCurrencies: new Set(rateSnapshots.map((r) => r.currency)).size > 1,
    });
  }

  rows.sort((a, b) => {
    if (a.projectId === null) return 1;
    if (b.projectId === null) return -1;
    const byName = compareText(asciiCaseFold(a.projectName), asciiCaseFold(b.projectName));
    return byName !== 0 ? byName : compareText(a.projectId, b.projectId);
  });

  const totalsByCurrency: CurrencyAmount[] = [...currencyTotals.entries()]
    .sort((a, b) => compareCurrencies(a[0], b[0]))
    .map(([currency, t]) => ({ currency, ...t }));

  const byTag: TagReportRow[] = [...tagTotals.entries()]
    .map(([tagId, durationMs]) => ({ tagId, tagName: tagsById.get(tagId)?.name ?? UNKNOWN_TAG_LABEL, durationMs }))
    .sort((a, b) => {
      const byName = compareText(asciiCaseFold(a.tagName), asciiCaseFold(b.tagName));
      return byName !== 0 ? byName : compareText(a.tagId, b.tagId);
    });

  return ok({ period: period.value, totalMs, billableMs, byDay, byProject: rows, totalsByCurrency, byTag, untaggedMs });
}

