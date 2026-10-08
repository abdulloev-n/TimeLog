import { fail, ok, type Result } from './result.ts';

export const SUPPORTED_CURRENCIES = [
  'USD',
  'GBP',
  'EUR',
  'TJS',
  'TRY',
  'CNY',
  'RUB',
  'KZT',
  'CHF',
  'AED',
] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

export interface CurrencyInfo {
  readonly code: CurrencyCode;
  readonly name: string;
  readonly symbol: string;
  /** Every supported currency uses two decimal places in this application. */
  readonly minorUnits: 2;
}

export const DEFAULT_CURRENCY: CurrencyCode = 'USD';

export const CURRENCIES: Readonly<Record<CurrencyCode, CurrencyInfo>> = Object.freeze({
  USD: Object.freeze({ code: 'USD', name: 'US Dollar', symbol: '$', minorUnits: 2 }),
  GBP: Object.freeze({ code: 'GBP', name: 'British Pound', symbol: '£', minorUnits: 2 }),
  EUR: Object.freeze({ code: 'EUR', name: 'Euro', symbol: '€', minorUnits: 2 }),
  TJS: Object.freeze({ code: 'TJS', name: 'Tajikistani Somoni', symbol: 'SM', minorUnits: 2 }),
  TRY: Object.freeze({ code: 'TRY', name: 'Turkish Lira', symbol: '₺', minorUnits: 2 }),
  CNY: Object.freeze({ code: 'CNY', name: 'Chinese Yuan', symbol: '¥', minorUnits: 2 }),
  RUB: Object.freeze({ code: 'RUB', name: 'Russian Ruble', symbol: '₽', minorUnits: 2 }),
  KZT: Object.freeze({ code: 'KZT', name: 'Kazakhstani Tenge', symbol: '₸', minorUnits: 2 }),
  CHF: Object.freeze({ code: 'CHF', name: 'Swiss Franc', symbol: 'CHF', minorUnits: 2 }),
  AED: Object.freeze({ code: 'AED', name: 'UAE Dirham', symbol: 'AED', minorUnits: 2 }),
} satisfies Record<CurrencyCode, CurrencyInfo>);

export function listCurrencies(): readonly CurrencyInfo[] {
  return SUPPORTED_CURRENCIES.map((code) => CURRENCIES[code]);
}

export function isSupportedCurrency(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export function validateCurrency(value: unknown, field = 'currency'): Result<CurrencyCode> {
  if (!isSupportedCurrency(value)) {
    return fail(
      'UNSUPPORTED_CURRENCY',
      `${field} must be one of: ${SUPPORTED_CURRENCIES.join(', ')}.`,
      { field },
    );
  }
  return ok(value);
}

/** Orders currencies by their position in SUPPORTED_CURRENCIES. */
export function compareCurrencies(a: CurrencyCode, b: CurrencyCode): number {
  return SUPPORTED_CURRENCIES.indexOf(a) - SUPPORTED_CURRENCIES.indexOf(b);
}

