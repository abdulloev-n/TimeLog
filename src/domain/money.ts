import { CURRENCIES, type CurrencyCode } from './currency.ts';
import { fail, ok, type Result } from './result.ts';
import { HOUR_MS } from './validation.ts';

export const MAX_AMOUNT_MINOR = Number.MAX_SAFE_INTEGER;

const HOUR_BIG = BigInt(HOUR_MS);
const HALF_HOUR_BIG = HOUR_BIG / 2n;
const MAX_BIG = BigInt(MAX_AMOUNT_MINOR);
const FIELD = 'hourlyRate';

/**
 * Parses user rate input into integer minor units.
 * Accepts "25", "25.5", "25.50", "25,50". Rejects thousands separators,
 * more than two decimals and anything ambiguous. Uses BigInt, never floats.
 */
export function parseRateInput(input: unknown): Result<number> {
  if (typeof input !== 'string') {
    return fail('RATE_INPUT_INVALID_FORMAT', 'Enter the rate as text, for example 25.50.', { field: FIELD });
  }
  const text = input.trim();
  if (text === '') return fail('RATE_INPUT_EMPTY', 'Enter an hourly rate.', { field: FIELD });
  if (text.startsWith('-')) return fail('RATE_INPUT_NEGATIVE', 'The hourly rate cannot be negative.', { field: FIELD });
  if (!/^[0-9.,]+$/.test(text)) {
    return fail(
      'RATE_INPUT_INVALID_FORMAT',
      'Use digits with one optional decimal dot or comma, for example 25.50 or 25,50.',
      { field: FIELD },
    );
  }
  const separatorCount = (text.match(/[.,]/g) ?? []).length;
  if (separatorCount > 1) {
    return fail(
      'RATE_INPUT_AMBIGUOUS',
      'Use one decimal separator and no thousands separators, for example 1250.50.',
      { field: FIELD },
    );
  }
  const parts = text.split(/[.,]/);
  const integerPart = parts[0] ?? '';
  const fractionPart = parts[1];
  if (integerPart === '') {
    return fail('RATE_INPUT_INVALID_FORMAT', 'Put at least one digit before the decimal separator, for example 0.50.', {
      field: FIELD,
    });
  }
  if (fractionPart !== undefined) {
    if (fractionPart === '') {
      return fail('RATE_INPUT_INVALID_FORMAT', 'Put one or two digits after the decimal separator, or remove it.', {
        field: FIELD,
      });
    }
    if (fractionPart.length === 3 && /^[1-9][0-9]{0,2}$/.test(integerPart)) {
      return fail(
        'RATE_INPUT_AMBIGUOUS',
        `"${text}" could use a thousands separator or three decimals. Enter at most two decimals and no thousands separators.`,
        { field: FIELD },
      );
    }
    if (fractionPart.length > 2) {
      return fail('RATE_INPUT_TOO_MANY_DECIMALS', 'Use at most two decimal places.', { field: FIELD });
    }
  }
  const minor = BigInt(integerPart) * 100n + BigInt((fractionPart ?? '').padEnd(2, '0'));
  if (minor > MAX_BIG) return fail('AMOUNT_OUT_OF_RANGE', 'The hourly rate is too large.', { field: FIELD });
  return ok(Number(minor));
}

/** "2550" -> "25.50". Works for any safe integer. */
export function formatMinorUnits(amountMinor: number): string {
  const big = BigInt(amountMinor);
  const negative = big < 0n;
  const abs = negative ? -big : big;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/** "$25.50", "€0.05", "CHF 1000.00". Letter symbols get a space. */
export function formatMoney(amountMinor: number, currency: CurrencyCode): string {
  const symbol = CURRENCIES[currency].symbol;
  const amount = formatMinorUnits(amountMinor);
  return /^[A-Za-z]+$/.test(symbol) ? `${symbol} ${amount}` : `${symbol}${amount}`;
}

/** Exact product durationMs * rateMinor. Divide by one hour to get minor units. */
export function amountNumerator(durationMs: number, rateMinor: number): bigint {
  return BigInt(durationMs) * BigInt(rateMinor);
}

/** Rounds an accumulated numerator to minor units, half up. */
export function roundAmountNumerator(numerator: bigint): Result<number> {
  if (numerator < 0n) return fail('AMOUNT_OUT_OF_RANGE', 'An amount cannot be negative.');
  const rounded = (numerator + HALF_HOUR_BIG) / HOUR_BIG;
  if (rounded > MAX_BIG) return fail('AMOUNT_OUT_OF_RANGE', 'The amount exceeds the supported range.');
  return ok(Number(rounded));
}

/** Amount for one exact duration at one hourly rate, rounded half up once. */
export function calculateAmountMinor(durationMs: number, rateMinor: number): Result<number> {
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
    return fail('INVALID_NUMBER', 'durationMs must be a nonnegative integer.', { field: 'durationMs' });
  }
  if (!Number.isSafeInteger(rateMinor) || rateMinor < 0) {
    return fail('INVALID_RATE', 'rateMinor must be a nonnegative integer of minor units.', { field: 'rateMinor' });
  }
  return roundAmountNumerator(amountNumerator(durationMs, rateMinor));
}

/** Safe addition of minor-unit amounts. */
export function addAmounts(a: number, b: number): Result<number> {
  const sum = BigInt(a) + BigInt(b);
  if (sum > MAX_BIG || sum < 0n) return fail('AMOUNT_OUT_OF_RANGE', 'The total exceeds the supported range.');
  return ok(Number(sum));
}

/** Decimal hours with two places, half up. 3_618_000 ms -> "1.01". Display only. */
export function formatDecimalHours(durationMs: number): string {
  const hundredths = (BigInt(durationMs) * 100n + HALF_HOUR_BIG) / HOUR_BIG;
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, '0');
  return `${whole.toString()}.${fraction}`;
}

