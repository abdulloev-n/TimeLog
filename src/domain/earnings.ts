import { compareCurrencies, type CurrencyCode } from './currency.ts';
import { addAmounts, amountNumerator, roundAmountNumerator } from './money.ts';
import { ok, type Result } from './result.ts';

/**
 * One rounding rule for reports and invoices:
 * 1. Group billable, rated time by projectId + currency + hourlyRateMinor.
 * 2. Round each group once: exact milliseconds x rate / 1 hour, half up.
 * 3. Add the rounded group amounts. Never add different currencies.
 */
export interface EarningsSegment {
  readonly projectId: string | null;
  readonly currency: CurrencyCode;
  readonly hourlyRateMinor: number;
  readonly durationMs: number;
}

export interface EarningsGroup {
  readonly projectId: string | null;
  readonly currency: CurrencyCode;
  readonly hourlyRateMinor: number;
  readonly durationMs: number;
  /** How many segments (clipped entries) fed this group. */
  readonly segmentCount: number;
  readonly amountMinor: number;
}

export function earningsGroupKey(projectId: string | null, currency: CurrencyCode, hourlyRateMinor: number): string {
  return `${projectId ?? ''}|${currency}|${hourlyRateMinor}`;
}

function compareGroups(a: EarningsGroup, b: EarningsGroup): number {
  const pa = a.projectId ?? '\uffff';
  const pb = b.projectId ?? '\uffff';
  if (pa !== pb) return pa < pb ? -1 : 1;
  const byCurrency = compareCurrencies(a.currency, b.currency);
  if (byCurrency !== 0) return byCurrency;
  return a.hourlyRateMinor - b.hourlyRateMinor;
}

/** Groups segments and rounds each group once. Output order is deterministic. */
export function groupEarnings(segments: readonly EarningsSegment[]): Result<readonly EarningsGroup[]> {
  const acc = new Map<
    string,
    { projectId: string | null; currency: CurrencyCode; rate: number; durationMs: number; numerator: bigint; count: number }
  >();
  for (const s of segments) {
    const key = earningsGroupKey(s.projectId, s.currency, s.hourlyRateMinor);
    const g = acc.get(key) ?? {
      projectId: s.projectId,
      currency: s.currency,
      rate: s.hourlyRateMinor,
      durationMs: 0,
      numerator: 0n,
      count: 0,
    };
    g.durationMs += s.durationMs;
    g.numerator += amountNumerator(s.durationMs, s.hourlyRateMinor);
    g.count += 1;
    acc.set(key, g);
  }
  const groups: EarningsGroup[] = [];
  for (const g of acc.values()) {
    const amount = roundAmountNumerator(g.numerator);
    if (!amount.ok) return amount;
    groups.push({
      projectId: g.projectId,
      currency: g.currency,
      hourlyRateMinor: g.rate,
      durationMs: g.durationMs,
      segmentCount: g.count,
      amountMinor: amount.value,
    });
  }
  return ok(groups.sort(compareGroups));
}

/** Adds rounded group amounts with overflow checks. Callers pass groups of one currency. */
export function sumGroupAmounts(groups: readonly { readonly amountMinor: number }[]): Result<number> {
  let total = 0;
  for (const g of groups) {
    const sum = addAmounts(total, g.amountMinor);
    if (!sum.ok) return sum;
    total = sum.value;
  }
  return ok(total);
}

