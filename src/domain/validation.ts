import { fail, ok, type Result } from './result.ts';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const MIN_ENTRY_DURATION_MS = MINUTE_MS;
export const MAX_ENTRY_DURATION_MS = DAY_MS;
export const MAX_NAME_LENGTH = 200;
export const MAX_TEXT_LENGTH = 1_000;
export const MAX_NOTE_LENGTH = 2_000;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

export function validateId(value: unknown, field = 'id'): Result<string> {
  if (!isUuidV4(value)) return fail('INVALID_ID', `${field} must be a UUID v4 string.`, { field });
  return ok(value);
}

/** Accepts a nonnegative safe integer of epoch milliseconds (UTC instant). */
export function validateTimestamp(value: unknown, field = 'timestamp'): Result<number> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return fail(
      'INVALID_TIMESTAMP',
      `${field} must be a nonnegative integer of epoch milliseconds.`,
      { field },
    );
  }
  return ok(value);
}

export function validateNonNegativeInteger(value: unknown, field: string): Result<number> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return fail('INVALID_NUMBER', `${field} must be a nonnegative integer.`, { field });
  }
  return ok(value);
}

export function validateBoolean(value: unknown, field: string): Result<boolean> {
  if (typeof value !== 'boolean') return fail('INVALID_BOOLEAN', `${field} must be true or false.`, { field });
  return ok(value);
}

/** Trims a required name. Rejects non-strings, empty names and names over maxLength. */
export function normalizeName(value: unknown, field = 'name', maxLength = MAX_NAME_LENGTH): Result<string> {
  if (typeof value !== 'string') return fail('INVALID_TEXT', `${field} must be text.`, { field });
  const trimmed = value.trim();
  if (trimmed === '') return fail('EMPTY_NAME', `Enter a ${field}.`, { field });
  if (trimmed.length > maxLength) {
    return fail('TEXT_TOO_LONG', `${field} cannot exceed ${maxLength} characters.`, { field });
  }
  return ok(trimmed);
}

/** Trims optional text. Null, undefined and blank strings become null. */
export function normalizeOptionalText(
  value: unknown,
  field: string,
  maxLength = MAX_TEXT_LENGTH,
): Result<string | null> {
  if (value === null || value === undefined) return ok(null);
  if (typeof value !== 'string') return fail('INVALID_TEXT', `${field} must be text.`, { field });
  const trimmed = value.trim();
  if (trimmed === '') return ok(null);
  if (trimmed.length > maxLength) {
    return fail('TEXT_TOO_LONG', `${field} cannot exceed ${maxLength} characters.`, { field });
  }
  return ok(trimmed);
}

/** Entry descriptions are stored in time_entries.note. Undefined and null become ''. */
export function normalizeNote(value: unknown): Result<string> {
  if (value === null || value === undefined) return ok('');
  if (typeof value !== 'string') return fail('INVALID_TEXT', 'note must be text.', { field: 'note' });
  const trimmed = value.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) {
    return fail('TEXT_TOO_LONG', `note cannot exceed ${MAX_NOTE_LENGTH} characters.`, { field: 'note' });
  }
  return ok(trimmed);
}

export function validateEmail(value: unknown, field = 'email'): Result<string | null> {
  const text = normalizeOptionalText(value, field, 320);
  if (!text.ok || text.value === null) return text;
  if (!EMAIL.test(text.value)) return fail('INVALID_EMAIL', `${field} must look like name@example.com.`, { field });
  return ok(text.value);
}

/** Hourly rate in integer minor units. Null means "no rate". Zero is valid. */
export function validateRateMinor(value: unknown, field = 'hourlyRateMinor'): Result<number | null> {
  if (value === null) return ok(null);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail('INVALID_NUMBER', `${field} must be a finite number or null.`, { field });
  }
  if (value < 0) return fail('NEGATIVE_RATE', `${field} cannot be negative.`, { field });
  if (!Number.isSafeInteger(value)) {
    return fail('INVALID_RATE', `${field} must be a safe integer of minor units, for example 2550 for 25.50.`, { field });
  }
  return ok(value);
}

