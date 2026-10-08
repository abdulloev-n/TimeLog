import { compareCurrencies, isSupportedCurrency, validateCurrency, type CurrencyCode } from './currency.ts';
import { asciiCaseFold, type ProjectInfo } from './entities.ts';
import { groupEarnings, sumGroupAmounts, type EarningsSegment } from './earnings.ts';
import { validateStoredEntries, type TimeEntry } from './entries.ts';
import { formatDecimalHours } from './money.ts';
import { clipInterval, validatePeriod, type Period } from './periods.ts';
import { fail, ok, type Result } from './result.ts';
import {
  MAX_NOTE_LENGTH,
  normalizeName,
  normalizeOptionalText,
  validateEmail,
  validateId,
  validateTimestamp,
} from './validation.ts';

export const DEFAULT_INVOICE_NUMBER_PADDING = 4;
export const MAX_INVOICE_PREFIX_LENGTH = 20;

export interface SenderDetailsInput {
  readonly name: string;
  readonly address?: string | null;
  readonly email?: string | null;
  readonly paymentDetails?: string | null;
}

export interface SenderSnapshot {
  readonly name: string;
  readonly address: string | null;
  readonly email: string | null;
  readonly paymentDetails: string | null;
}

export interface InvoiceClientInput {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly address: string | null;
}

export interface ClientSnapshot {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly address: string | null;
}

export interface InvoiceLine {
  readonly projectId: string;
  readonly projectName: string;
  /** Exact clipped duration. Amounts use this value. */
  readonly durationMs: number;
  /** Display only, two decimals, half up. */
  readonly hours: string;
  readonly hourlyRateMinor: number;
  readonly currency: CurrencyCode;
  readonly amountMinor: number;
  readonly entryCount: number;
}

export interface InvoiceDraftInput {
  readonly client: InvoiceClientInput;
  readonly sender: SenderDetailsInput;
  readonly period: Period;
  readonly entries: readonly TimeEntry[];
  /** Include archived projects. Projects of other clients are ignored. */
  readonly projects: readonly ProjectInfo[];
  /** Required when eligible entries use more than one currency. */
  readonly currency?: CurrencyCode | null;
}

export interface InvoiceDraft {
  readonly clientId: string;
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly currency: CurrencyCode;
  readonly lines: readonly InvoiceLine[];
  readonly totalMinor: number;
  readonly sender: SenderSnapshot;
  readonly client: ClientSnapshot;
  readonly linesJson: string;
  readonly senderJson: string;
  readonly clientJson: string;
}

/** Column names match the invoices table. */
export interface InvoiceRow {
  readonly id: string;
  readonly number: string;
  readonly sequence_number: number;
  readonly client_id: string;
  readonly period_start: number;
  readonly period_end: number;
  readonly currency: CurrencyCode;
  readonly total_minor: number;
  readonly lines_json: string;
  readonly sender_json: string;
  readonly client_json: string;
  readonly issued_at: number;
}

export interface InvoiceAllocation {
  readonly id: string;
  readonly prefix: string;
  /** From nextInvoiceSequence(), read inside the same transaction as the insert. */
  readonly sequenceNumber: number;
  readonly issuedAt: number;
  readonly padding?: number;
}

export interface InvoiceSnapshot {
  readonly currency: CurrencyCode;
  readonly lines: readonly InvoiceLine[];
  readonly sender: SenderSnapshot;
  readonly client: ClientSnapshot;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function normalizeSenderDetails(input: SenderDetailsInput): Result<SenderSnapshot> {
  const name = normalizeName(input.name, 'sender name');
  if (!name.ok) return name;
  const address = normalizeOptionalText(input.address ?? null, 'sender address');
  if (!address.ok) return address;
  const email = validateEmail(input.email ?? null, 'sender email');
  if (!email.ok) return email;
  const payment = normalizeOptionalText(input.paymentDetails ?? null, 'payment details', MAX_NOTE_LENGTH);
  if (!payment.ok) return payment;
  return ok({ name: name.value, address: address.value, email: email.value, paymentDetails: payment.value });
}

/**
 * Builds an immutable invoice snapshot. Rounding follows earnings.ts:
 * one rounded amount per projectId + currency + rate, then a sum, the same as buildReport. Includes finished, billable, rated entries
 * of the client's projects (archived included), clipped to the period.
 * One line per project and rate.
 */
export function prepareInvoiceDraft(input: InvoiceDraftInput): Result<InvoiceDraft> {
  const period = validatePeriod(input.period, 'period');
  if (!period.ok) return period;
  const clientId = validateId(input.client.id, 'client.id');
  if (!clientId.ok) return clientId;
  const clientName = normalizeName(input.client.name, 'client name');
  if (!clientName.ok) return clientName;
  const clientEmail = validateEmail(input.client.email, 'client email');
  if (!clientEmail.ok) return clientEmail;
  const clientAddress = normalizeOptionalText(input.client.address, 'client address');
  if (!clientAddress.ok) return clientAddress;
  const sender = normalizeSenderDetails(input.sender);
  if (!sender.ok) return sender;
  const stored = validateStoredEntries(input.entries, 'entries');
  if (!stored.ok) return stored;

  const clientProjects = new Map(
    input.projects.filter((p) => p.clientId === clientId.value).map((p) => [p.id, p] as const),
  );

  interface Eligible {
    projectId: string;
    rate: number;
    currency: CurrencyCode;
    durationMs: number;
  }
  const eligible: Eligible[] = [];
  for (const entry of stored.value) {
    if (entry.endAt === null || !entry.billable || entry.hourlyRateMinor === null) continue;
    if (entry.projectId === null || !clientProjects.has(entry.projectId)) continue;
    const clipped = clipInterval(entry.startAt, entry.endAt, period.value);
    if (clipped === null) continue;
    eligible.push({
      projectId: entry.projectId,
      rate: entry.hourlyRateMinor,
      currency: entry.currency,
      durationMs: clipped.endMs - clipped.startMs,
    });
  }
  if (eligible.length === 0) {
    return fail(
      'INVOICE_NO_ELIGIBLE_ENTRIES',
      'This client has no finished, billable entries with a rate in the selected period.',
    );
  }

  const currencies = [...new Set(eligible.map((e) => e.currency))].sort(compareCurrencies);
  let currency: CurrencyCode;
  if (input.currency === undefined || input.currency === null) {
    if (currencies.length > 1) {
      return fail(
        'INVOICE_MIXED_CURRENCIES',
        `The selected entries use several currencies (${currencies.join(', ')}). Choose one currency for this invoice.`,
        { currencies, field: 'currency' },
      );
    }
    currency = currencies[0] as CurrencyCode;
  } else {
    const chosen = validateCurrency(input.currency);
    if (!chosen.ok) return chosen;
    if (!currencies.includes(chosen.value)) {
      return fail(
        'INVOICE_CURRENCY_NOT_FOUND',
        `No eligible entries use ${chosen.value}. Available: ${currencies.join(', ')}.`,
        { currencies, field: 'currency' },
      );
    }
    currency = chosen.value;
  }

  const segments: EarningsSegment[] = eligible
    .filter((e) => e.currency === currency)
    .map((e) => ({ projectId: e.projectId, currency: e.currency, hourlyRateMinor: e.rate, durationMs: e.durationMs }));
  const groups = groupEarnings(segments);
  if (!groups.ok) return groups;
  const total = sumGroupAmounts(groups.value);
  if (!total.ok) return total;
  const totalMinor = total.value;

  const lines: InvoiceLine[] = groups.value.map((g) => {
    const projectId = g.projectId as string;
    return {
      projectId,
      projectName: clientProjects.get(projectId)?.name ?? 'Unknown project',
      durationMs: g.durationMs,
      hours: formatDecimalHours(g.durationMs),
      hourlyRateMinor: g.hourlyRateMinor,
      currency,
      amountMinor: g.amountMinor,
      entryCount: g.segmentCount,
    };
  });
  lines.sort((a, b) => {
    const byName = compareText(asciiCaseFold(a.projectName), asciiCaseFold(b.projectName));
    if (byName !== 0) return byName;
    const byId = compareText(a.projectId, b.projectId);
    return byId !== 0 ? byId : a.hourlyRateMinor - b.hourlyRateMinor;
  });

  const client: ClientSnapshot = {
    id: clientId.value,
    name: clientName.value,
    email: clientEmail.value,
    address: clientAddress.value,
  };
  return ok({
    clientId: clientId.value,
    periodStart: period.value.startMs,
    periodEnd: period.value.endMs,
    currency,
    lines,
    totalMinor,
    sender: sender.value,
    client,
    linesJson: JSON.stringify(lines),
    senderJson: JSON.stringify(sender.value),
    clientJson: JSON.stringify(client),
  });
}

/** Letters, digits and - _ / . # only. Up to 20 characters. Empty is allowed. */
export function normalizeInvoicePrefix(prefix: unknown): Result<string> {
  if (typeof prefix !== 'string') return fail('INVALID_INVOICE_PREFIX', 'The invoice prefix must be text.', { field: 'prefix' });
  const trimmed = prefix.trim();
  if (trimmed.length > MAX_INVOICE_PREFIX_LENGTH) {
    return fail('INVALID_INVOICE_PREFIX', `The invoice prefix cannot exceed ${MAX_INVOICE_PREFIX_LENGTH} characters.`, {
      field: 'prefix',
    });
  }
  if (!/^[A-Za-z0-9\-_/.#]*$/.test(trimmed)) {
    return fail('INVALID_INVOICE_PREFIX', 'Use letters, digits and - _ / . # in the invoice prefix.', { field: 'prefix' });
  }
  return ok(trimmed);
}

/** "INV-" + 7 -> "INV-0007". Longer sequences are never cut: 12345 -> "INV-12345". */
export function formatInvoiceNumber(
  prefix: string,
  sequenceNumber: number,
  padding = DEFAULT_INVOICE_NUMBER_PADDING,
): Result<string> {
  const p = normalizeInvoicePrefix(prefix);
  if (!p.ok) return p;
  if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 1) {
    return fail('INVALID_INVOICE_SEQUENCE', 'The invoice sequence number must be a positive integer.', {
      field: 'sequenceNumber',
    });
  }
  if (!Number.isInteger(padding) || padding < 1 || padding > 12) {
    return fail('INVALID_INVOICE_SEQUENCE', 'Padding must be an integer from 1 to 12.', { field: 'padding' });
  }
  return ok(`${p.value}${String(sequenceNumber).padStart(padding, '0')}`);
}

/**
 * Allocation contract: pass MAX(sequence_number) read inside the insert transaction
 * (null when no invoices exist). Returns the next global sequence number.
 */
export function nextInvoiceSequence(currentMax: number | null): Result<number> {
  if (currentMax === null) return ok(1);
  if (!Number.isSafeInteger(currentMax) || currentMax < 1) {
    return fail('INVALID_INVOICE_SEQUENCE', 'The current maximum sequence must be a positive integer or null.', {
      field: 'currentMax',
    });
  }
  if (currentMax >= Number.MAX_SAFE_INTEGER) {
    return fail('INVALID_INVOICE_SEQUENCE', 'The invoice sequence is exhausted.', { field: 'currentMax' });
  }
  return ok(currentMax + 1);
}

/** Produces the row to INSERT. The number stays reserved once inserted, even if PDF saving is cancelled. */
export function buildInvoiceRow(draft: InvoiceDraft, allocation: InvoiceAllocation): Result<InvoiceRow> {
  const id = validateId(allocation.id, 'id');
  if (!id.ok) return id;
  const issuedAt = validateTimestamp(allocation.issuedAt, 'issuedAt');
  if (!issuedAt.ok) return issuedAt;
  const number = formatInvoiceNumber(allocation.prefix, allocation.sequenceNumber, allocation.padding);
  if (!number.ok) return number;
  return ok({
    id: id.value,
    number: number.value,
    sequence_number: allocation.sequenceNumber,
    client_id: draft.clientId,
    period_start: draft.periodStart,
    period_end: draft.periodEnd,
    currency: draft.currency,
    total_minor: draft.totalMinor,
    lines_json: draft.linesJson,
    sender_json: draft.senderJson,
    client_json: draft.clientJson,
    issued_at: issuedAt.value,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function badSnapshot(detail: string): Result<never> {
  return fail('INVALID_INVOICE_SNAPSHOT', `The stored invoice snapshot is damaged: ${detail}.`);
}

/** Reads a stored invoice for re-printing. Never reads live client, project or settings records. */
export function readInvoiceSnapshot(
  row: Pick<InvoiceRow, 'currency' | 'lines_json' | 'sender_json' | 'client_json'>,
): Result<InvoiceSnapshot> {
  if (!isSupportedCurrency(row.currency)) return badSnapshot('unsupported currency');
  let linesRaw: unknown;
  let senderRaw: unknown;
  let clientRaw: unknown;
  try {
    linesRaw = JSON.parse(row.lines_json);
    senderRaw = JSON.parse(row.sender_json);
    clientRaw = JSON.parse(row.client_json);
  } catch {
    return badSnapshot('invalid JSON');
  }
  if (!Array.isArray(linesRaw)) return badSnapshot('lines are not a list');
  const lines: InvoiceLine[] = [];
  for (const raw of linesRaw as unknown[]) {
    if (
      !isRecord(raw) ||
      typeof raw.projectId !== 'string' ||
      typeof raw.projectName !== 'string' ||
      !isNonNegativeSafeInt(raw.durationMs) ||
      typeof raw.hours !== 'string' ||
      !isNonNegativeSafeInt(raw.hourlyRateMinor) ||
      !isSupportedCurrency(raw.currency) ||
      !isNonNegativeSafeInt(raw.amountMinor) ||
      !isNonNegativeSafeInt(raw.entryCount)
    ) {
      return badSnapshot('a line has missing or wrong fields');
    }
    lines.push({
      projectId: raw.projectId,
      projectName: raw.projectName,
      durationMs: raw.durationMs,
      hours: raw.hours,
      hourlyRateMinor: raw.hourlyRateMinor,
      currency: raw.currency,
      amountMinor: raw.amountMinor,
      entryCount: raw.entryCount,
    });
  }
  if (
    !isRecord(senderRaw) ||
    typeof senderRaw.name !== 'string' ||
    !isNullableString(senderRaw.address) ||
    !isNullableString(senderRaw.email) ||
    !isNullableString(senderRaw.paymentDetails)
  ) {
    return badSnapshot('sender details have missing or wrong fields');
  }
  if (
    !isRecord(clientRaw) ||
    typeof clientRaw.id !== 'string' ||
    typeof clientRaw.name !== 'string' ||
    !isNullableString(clientRaw.email) ||
    !isNullableString(clientRaw.address)
  ) {
    return badSnapshot('client details have missing or wrong fields');
  }
  return ok({
    currency: row.currency,
    lines,
    sender: {
      name: senderRaw.name,
      address: senderRaw.address,
      email: senderRaw.email,
      paymentDetails: senderRaw.paymentDetails,
    },
    client: { id: clientRaw.id, name: clientRaw.name, email: clientRaw.email, address: clientRaw.address },
  });
}

