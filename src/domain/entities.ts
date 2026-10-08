import { DEFAULT_CURRENCY, validateCurrency, type CurrencyCode } from './currency.ts';
import { fail, ok, type Result } from './result.ts';
import {
  normalizeName,
  normalizeOptionalText,
  validateEmail,
  validateId,
  validateRateMinor,
  validateTimestamp,
} from './validation.ts';

export interface Client {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly address: string | null;
  /** Preferred currency. Suggests the currency for new projects. */
  readonly currency: CurrencyCode;
  readonly archived: boolean;
  readonly createdAt: number;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly clientId: string | null;
  /** Integer minor units. Null means no rate. */
  readonly hourlyRateMinor: number | null;
  /** Controls earnings for entries created under this project. */
  readonly currency: CurrencyCode;
  readonly archived: boolean;
  readonly createdAt: number;
}

/** Minimal project data that reports and invoices need. */
export interface ProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly clientId: string | null;
  readonly archived: boolean;
}

export interface Tag {
  readonly id: string;
  readonly name: string;
}

export interface ClientInput {
  readonly id: string;
  readonly name: string;
  readonly email?: string | null;
  readonly address?: string | null;
  readonly currency?: CurrencyCode;
  readonly createdAt: number;
}

export interface ClientChanges {
  readonly name?: string;
  readonly email?: string | null;
  readonly address?: string | null;
  readonly currency?: CurrencyCode;
}

export interface ProjectInput {
  readonly id: string;
  readonly name: string;
  readonly clientId?: string | null;
  readonly hourlyRateMinor?: number | null;
  readonly currency?: CurrencyCode;
  readonly createdAt: number;
}

export interface ProjectChanges {
  readonly name?: string;
  readonly clientId?: string | null;
  readonly hourlyRateMinor?: number | null;
  readonly currency?: CurrencyCode;
}

export function prepareClient(input: ClientInput): Result<Client> {
  const id = validateId(input.id, 'id');
  if (!id.ok) return id;
  const createdAt = validateTimestamp(input.createdAt, 'createdAt');
  if (!createdAt.ok) return createdAt;
  return buildClient(id.value, createdAt.value, false, input);
}

export function updateClient(existing: Client, changes: ClientChanges): Result<Client> {
  return buildClient(existing.id, existing.createdAt, existing.archived, {
    name: changes.name ?? existing.name,
    email: changes.email !== undefined ? changes.email : existing.email,
    address: changes.address !== undefined ? changes.address : existing.address,
    currency: changes.currency ?? existing.currency,
  });
}

function buildClient(
  id: string,
  createdAt: number,
  archived: boolean,
  fields: { name: string; email?: string | null; address?: string | null; currency?: CurrencyCode },
): Result<Client> {
  const name = normalizeName(fields.name, 'client name');
  if (!name.ok) return name;
  const email = validateEmail(fields.email ?? null);
  if (!email.ok) return email;
  const address = normalizeOptionalText(fields.address ?? null, 'address');
  if (!address.ok) return address;
  const currency = validateCurrency(fields.currency ?? DEFAULT_CURRENCY);
  if (!currency.ok) return currency;
  return ok({
    id,
    name: name.value,
    email: email.value,
    address: address.value,
    currency: currency.value,
    archived,
    createdAt,
  });
}

/** The client's currency is the initial suggestion for a new project. USD without a client. */
export function suggestProjectCurrency(client: Pick<Client, 'currency'> | null): CurrencyCode {
  return client === null ? DEFAULT_CURRENCY : client.currency;
}

export function prepareProject(input: ProjectInput): Result<Project> {
  const id = validateId(input.id, 'id');
  if (!id.ok) return id;
  const createdAt = validateTimestamp(input.createdAt, 'createdAt');
  if (!createdAt.ok) return createdAt;
  return buildProject(id.value, createdAt.value, false, input);
}

/**
 * Changing hourlyRateMinor or currency affects entries created afterwards.
 * Existing entries keep their own rate and currency snapshots.
 */
export function updateProject(existing: Project, changes: ProjectChanges): Result<Project> {
  return buildProject(existing.id, existing.createdAt, existing.archived, {
    name: changes.name ?? existing.name,
    clientId: changes.clientId !== undefined ? changes.clientId : existing.clientId,
    hourlyRateMinor: changes.hourlyRateMinor !== undefined ? changes.hourlyRateMinor : existing.hourlyRateMinor,
    currency: changes.currency ?? existing.currency,
  });
}

function buildProject(
  id: string,
  createdAt: number,
  archived: boolean,
  fields: { name: string; clientId?: string | null; hourlyRateMinor?: number | null; currency?: CurrencyCode },
): Result<Project> {
  const name = normalizeName(fields.name, 'project name');
  if (!name.ok) return name;
  let clientId: string | null = null;
  if (fields.clientId !== undefined && fields.clientId !== null) {
    const validated = validateId(fields.clientId, 'clientId');
    if (!validated.ok) return validated;
    clientId = validated.value;
  }
  const rate = validateRateMinor(fields.hourlyRateMinor ?? null);
  if (!rate.ok) return rate;
  const currency = validateCurrency(fields.currency ?? DEFAULT_CURRENCY);
  if (!currency.ok) return currency;
  return ok({ id, name: name.value, clientId, hourlyRateMinor: rate.value, currency: currency.value, archived, createdAt });
}

/**
 * ASCII-only lowercase. Mirrors SQLite NOCASE, which folds A-Z only.
 * "Design" and "design" collide. "É" and "é" do not.
 */
export function asciiCaseFold(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function findTagNameConflict(name: string, tags: readonly Tag[], excludeTagId?: string): Tag | null {
  const folded = asciiCaseFold(name.trim());
  return tags.find((t) => t.id !== excludeTagId && asciiCaseFold(t.name) === folded) ?? null;
}

export function prepareTag(input: { readonly id: string; readonly name: string }, existing: readonly Tag[]): Result<Tag> {
  const id = validateId(input.id, 'id');
  if (!id.ok) return id;
  return buildTag(id.value, input.name, existing);
}

export function renameTag(tag: Tag, newName: string, existing: readonly Tag[]): Result<Tag> {
  return buildTag(tag.id, newName, existing);
}

function buildTag(id: string, rawName: string, existing: readonly Tag[]): Result<Tag> {
  const name = normalizeName(rawName, 'tag name', 50);
  if (!name.ok) return name;
  const conflict = findTagNameConflict(name.value, existing, id);
  if (conflict !== null) {
    return fail('DUPLICATE_TAG_NAME', `A tag named "${conflict.name}" already exists.`, { field: 'name' });
  }
  return ok({ id, name: name.value });
}

