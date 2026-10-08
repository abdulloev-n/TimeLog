import { describe, expect, it } from 'vitest';
import {
  CURRENCIES,
  SUPPORTED_CURRENCIES,
  calculateAmountMinor,
  formatDecimalHours,
  formatMinorUnits,
  formatMoney,
  listCurrencies,
  parseRateInput,
  validateCurrency,
} from '../../src/domain/index.ts';
import { HOUR, MIN } from './fixtures.ts';

function code(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

describe('parseRateInput', () => {
  it.each([
    ['25.50', 2550],
    ['25,50', 2550],
    ['25,5', 2550],
    ['25', 2500],
    ['0.07', 7],
    ['0', 0],
    ['  12.30  ', 1230],
    ['0.29', 29],
    ['1.10', 110],
    ['90071992547409.91', 9007199254740991],
  ])('parses %j as %d minor units', (input, expected) => {
    expect(parseRateInput(input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['', 'RATE_INPUT_EMPTY'],
    ['   ', 'RATE_INPUT_EMPTY'],
    ['-5', 'RATE_INPUT_NEGATIVE'],
    ['abc', 'RATE_INPUT_INVALID_FORMAT'],
    ['1e3', 'RATE_INPUT_INVALID_FORMAT'],
    ['$25', 'RATE_INPUT_INVALID_FORMAT'],
    ['1 000', 'RATE_INPUT_INVALID_FORMAT'],
    ['25.', 'RATE_INPUT_INVALID_FORMAT'],
    ['.5', 'RATE_INPUT_INVALID_FORMAT'],
    ['1,000', 'RATE_INPUT_AMBIGUOUS'],
    ['1.250', 'RATE_INPUT_AMBIGUOUS'],
    ['1.250,50', 'RATE_INPUT_AMBIGUOUS'],
    ['1,250.50', 'RATE_INPUT_AMBIGUOUS'],
    ['0.125', 'RATE_INPUT_TOO_MANY_DECIMALS'],
    ['1.2345', 'RATE_INPUT_TOO_MANY_DECIMALS'],
    ['90071992547409.92', 'AMOUNT_OUT_OF_RANGE'],
  ])('rejects %j with %s', (input, expected) => {
    expect(code(parseRateInput(input))).toBe(expected);
  });

  it('rejects non-string input', () => {
    expect(code(parseRateInput(25.5))).toBe('RATE_INPUT_INVALID_FORMAT');
  });
});

describe('calculateAmountMinor (half up, exact time)', () => {
  it('rounds half a minor unit up', () => {
    expect(calculateAmountMinor(30 * MIN, 1)).toEqual({ ok: true, value: 1 });
  });
  it('rounds just below half down', () => {
    expect(calculateAmountMinor(30 * MIN - 1, 1)).toEqual({ ok: true, value: 0 });
  });
  it('one minute at 25.50 per hour is 42.5 cents, rounded to 43', () => {
    expect(calculateAmountMinor(MIN, 2550)).toEqual({ ok: true, value: 43 });
  });
  it('one and a half hours at 25.50 is 38.25', () => {
    expect(calculateAmountMinor(90 * MIN, 2550)).toEqual({ ok: true, value: 3825 });
  });
  it('zero rate gives zero', () => {
    expect(calculateAmountMinor(5 * HOUR, 0)).toEqual({ ok: true, value: 0 });
  });
  it('rejects negative and fractional rates', () => {
    expect(code(calculateAmountMinor(HOUR, -1))).toBe('INVALID_RATE');
    expect(code(calculateAmountMinor(HOUR, 1.5))).toBe('INVALID_RATE');
  });
  it('rejects amounts beyond the safe integer range', () => {
    expect(code(calculateAmountMinor(2 * HOUR, Number.MAX_SAFE_INTEGER))).toBe('AMOUNT_OUT_OF_RANGE');
  });
});

describe('formatting', () => {
  it('formats decimal hours half up', () => {
    expect(formatDecimalHours(0)).toBe('0.00');
    expect(formatDecimalHours(90 * MIN)).toBe('1.50');
    expect(formatDecimalHours(20 * MIN)).toBe('0.33');
    expect(formatDecimalHours(50 * MIN)).toBe('0.83');
    // 1 h 0 min 18 s = 1.005 h -> 1.01
    expect(formatDecimalHours(HOUR + 18_000)).toBe('1.01');
  });

  it('formats minor units and money', () => {
    expect(formatMinorUnits(2550)).toBe('25.50');
    expect(formatMinorUnits(5)).toBe('0.05');
    expect(formatMinorUnits(9007199254740991)).toBe('90071992547409.91');
    expect(formatMoney(2550, 'USD')).toBe('$25.50');
    expect(formatMoney(5, 'EUR')).toBe('€0.05');
    expect(formatMoney(100000, 'CHF')).toBe('CHF 1000.00');
    expect(formatMoney(123456, 'TRY')).toBe('₺1234.56');
  });
});

describe('currencies', () => {
  it('lists exactly the ten supported currencies with names and symbols', () => {
    expect([...SUPPORTED_CURRENCIES]).toEqual(['USD', 'GBP', 'EUR', 'TJS', 'TRY', 'CNY', 'RUB', 'KZT', 'CHF', 'AED']);
    expect(listCurrencies()).toHaveLength(10);
    for (const info of listCurrencies()) {
      expect(info.name.length).toBeGreaterThan(0);
      expect(info.symbol.length).toBeGreaterThan(0);
      expect(info.minorUnits).toBe(2);
    }
    expect(CURRENCIES.GBP).toEqual({ code: 'GBP', name: 'British Pound', symbol: '£', minorUnits: 2 });
  });

  it('rejects unsupported codes', () => {
    expect(validateCurrency('JPY').ok).toBe(false);
    expect(validateCurrency('usd').ok).toBe(false);
    expect(validateCurrency('KZT')).toEqual({ ok: true, value: 'KZT' });
  });
});

