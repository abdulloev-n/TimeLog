import type { CurrencyCode } from './currency.ts';

/** Stable machine-readable error codes. The UI may switch on these values. */
export type ErrorCode =
  | 'INVALID_ID'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_NUMBER'
  | 'INVALID_BOOLEAN'
  | 'INVALID_TEXT'
  | 'INVALID_ENTRY'
  | 'INVALID_PROJECTLESS_SNAPSHOT'
  | 'EMPTY_NAME'
  | 'TEXT_TOO_LONG'
  | 'INVALID_EMAIL'
  | 'UNSUPPORTED_CURRENCY'
  | 'INVALID_RATE'
  | 'NEGATIVE_RATE'
  | 'RATE_INPUT_EMPTY'
  | 'RATE_INPUT_NEGATIVE'
  | 'RATE_INPUT_INVALID_FORMAT'
  | 'RATE_INPUT_AMBIGUOUS'
  | 'RATE_INPUT_TOO_MANY_DECIMALS'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'ENTRY_END_NOT_AFTER_START'
  | 'ENTRY_TOO_SHORT'
  | 'ENTRY_TOO_LONG'
  | 'ENTRY_OVERLAP'
  | 'TIMER_ALREADY_RUNNING'
  | 'TIMER_START_IN_FUTURE'
  | 'TIMER_NOT_RUNNING'
  | 'TIMER_STOP_IN_FUTURE'
  | 'CLOCK_CHANGED'
  | 'INVALID_PERIOD'
  | 'PERIODS_OVERLAP'
  | 'PERIOD_OUTSIDE_RANGE'
  | 'INVALID_GOAL'
  | 'DUPLICATE_TAG_NAME'
  | 'INVOICE_NO_ELIGIBLE_ENTRIES'
  | 'INVOICE_MIXED_CURRENCIES'
  | 'INVOICE_CURRENCY_NOT_FOUND'
  | 'INVALID_INVOICE_PREFIX'
  | 'INVALID_INVOICE_SEQUENCE'
  | 'INVALID_INVOICE_SNAPSHOT';

/** Describes an existing entry that blocks a proposed interval. */
export interface EntryConflict {
  readonly entryId: string;
  readonly startAt: number;
  /** Stored end. Null when the conflicting entry is the running timer. */
  readonly endAt: number | null;
  /** End used for the overlap check. For a running timer this is nowMs. */
  readonly effectiveEndMs: number;
  readonly running: boolean;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly note: string | null;
  /** Human label: note, else project name, else "No project" or "Untitled entry". */
  readonly label: string;
}

export interface DomainError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly field?: string;
  readonly conflict?: EntryConflict;
  readonly currencies?: readonly CurrencyCode[];
}

export type Success<T> = { readonly ok: true; readonly value: T };
export type Failure = { readonly ok: false; readonly error: DomainError };
export type Result<T> = Success<T> | Failure;

export function ok<T>(value: T): Success<T> {
  return { ok: true, value };
}

export function fail(
  code: ErrorCode,
  message: string,
  extra: Omit<DomainError, 'code' | 'message'> = {},
): Failure {
  return { ok: false, error: { code, message, ...extra } };
}

