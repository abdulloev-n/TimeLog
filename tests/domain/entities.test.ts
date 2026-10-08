import { describe, expect, it } from 'vitest';
import {
  decideClientRemoval,
  decideProjectRemoval,
  linksAfterEntryDeletion,
  linksAfterTagDeletion,
  prepareClient,
  prepareProject,
  prepareTag,
  renameTag,
  setArchived,
  suggestProjectCurrency,
  type ProjectInfo,
  type Tag,
} from '../../src/domain/index.ts';
import { T0, deepFreeze, uuid } from './fixtures.ts';

describe('clients and projects', () => {
  it('trims names and defaults the currency to USD', () => {
    const r = prepareClient({ id: uuid(1), name: '  Lumen  ', createdAt: T0 });
    expect(r).toEqual({
      ok: true,
      value: { id: uuid(1), name: 'Lumen', email: null, address: null, currency: 'USD', archived: false, createdAt: T0 },
    });
  });

  it('rejects empty names, bad emails and unsupported currencies', () => {
    expect(prepareClient({ id: uuid(1), name: '   ', createdAt: T0 })).toMatchObject({ ok: false, error: { code: 'EMPTY_NAME' } });
    expect(prepareClient({ id: uuid(1), name: 'A', email: 'nope', createdAt: T0 })).toMatchObject({ ok: false, error: { code: 'INVALID_EMAIL' } });
    expect(prepareClient({ id: uuid(1), name: 'A', currency: 'JPY' as 'USD', createdAt: T0 })).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_CURRENCY' },
    });
  });

  it('accepts a zero rate and a null rate, and rejects negative or fractional rates', () => {
    expect(prepareProject({ id: uuid(2), name: 'P', hourlyRateMinor: 0, createdAt: T0 })).toMatchObject({ ok: true, value: { hourlyRateMinor: 0 } });
    expect(prepareProject({ id: uuid(2), name: 'P', hourlyRateMinor: null, createdAt: T0 })).toMatchObject({ ok: true, value: { hourlyRateMinor: null } });
    expect(prepareProject({ id: uuid(2), name: 'P', hourlyRateMinor: -1, createdAt: T0 })).toMatchObject({ ok: false, error: { code: 'NEGATIVE_RATE' } });
    expect(prepareProject({ id: uuid(2), name: 'P', hourlyRateMinor: 10.5, createdAt: T0 })).toMatchObject({ ok: false, error: { code: 'INVALID_RATE' } });
    expect(prepareProject({ id: uuid(2), name: 'P', hourlyRateMinor: Number.POSITIVE_INFINITY, createdAt: T0 })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_NUMBER' },
    });
  });

  it('suggests the client currency for a new project', () => {
    expect(suggestProjectCurrency({ currency: 'TRY' })).toBe('TRY');
    expect(suggestProjectCurrency(null)).toBe('USD');
  });
});

describe('tags', () => {
  const existing: Tag[] = deepFreeze([{ id: uuid(10), name: 'Design' }]);

  it('rejects ASCII case-insensitive duplicates', () => {
    expect(prepareTag({ id: uuid(11), name: ' design ' }, existing)).toMatchObject({ ok: false, error: { code: 'DUPLICATE_TAG_NAME' } });
  });

  it('allows renaming a tag to a new casing of its own name', () => {
    expect(renameTag(existing[0] as Tag, 'DESIGN', existing)).toEqual({ ok: true, value: { id: uuid(10), name: 'DESIGN' } });
  });

  it('does not fold non-ASCII letters, matching SQLite NOCASE', () => {
    const accented: Tag[] = [{ id: uuid(12), name: 'Étude' }];
    expect(prepareTag({ id: uuid(13), name: 'étude' }, accented).ok).toBe(true);
  });
});

describe('archiving and deletion decisions', () => {
  const CLIENT = uuid(301);
  const projects: ProjectInfo[] = [
    { id: uuid(101), name: 'Website', clientId: CLIENT, archived: false },
    { id: uuid(102), name: 'Old brand', clientId: CLIENT, archived: true },
    { id: uuid(103), name: 'App', clientId: CLIENT, archived: false },
  ];

  it('archives a referenced project instead of deleting it', () => {
    expect(decideProjectRemoval({ project: { id: uuid(101), archived: false }, entryReferenceCount: 3 })).toMatchObject({
      ok: true,
      value: { action: 'archive' },
    });
  });

  it('allows deleting an unreferenced project after confirmation', () => {
    expect(decideProjectRemoval({ project: { id: uuid(101), archived: false }, entryReferenceCount: 0 })).toMatchObject({
      ok: true,
      value: { action: 'delete-after-confirmation' },
    });
  });

  it('leaves an archived referenced project alone', () => {
    expect(decideProjectRemoval({ project: { id: uuid(102), archived: true }, entryReferenceCount: 1 })).toMatchObject({
      ok: true,
      value: { action: 'already-archived' },
    });
  });

  it('archives a client with projects and lists its active projects', () => {
    const r = decideClientRemoval({ client: { id: CLIENT, archived: false }, projects, invoiceReferenceCount: 0 });
    expect(r.ok && r.value.action).toBe('archive');
    expect(r.ok && r.value.activeProjects).toEqual([
      { id: uuid(103), name: 'App' },
      { id: uuid(101), name: 'Website' },
    ]);
  });

  it('archives a client referenced only by invoices', () => {
    const r = decideClientRemoval({ client: { id: uuid(399), archived: false }, projects, invoiceReferenceCount: 2 });
    expect(r.ok && r.value).toMatchObject({ action: 'archive', activeProjects: [] });
  });

  it('allows deleting an unreferenced client after confirmation', () => {
    const r = decideClientRemoval({ client: { id: uuid(398), archived: false }, projects, invoiceReferenceCount: 0 });
    expect(r.ok && r.value.action).toBe('delete-after-confirmation');
  });

  it('archives by copy without mutating the input', () => {
    const project = deepFreeze({ id: uuid(101), name: 'Website', clientId: CLIENT, archived: false });
    expect(setArchived(project, true)).toEqual({ ...project, archived: true });
    expect(project.archived).toBe(false);
  });

  it('removes tag links on entry deletion and on tag deletion, leaving entries intact', () => {
    const links = deepFreeze([
      { entryId: uuid(1), tagId: uuid(10) },
      { entryId: uuid(1), tagId: uuid(11) },
      { entryId: uuid(2), tagId: uuid(10) },
    ]);
    expect(linksAfterEntryDeletion(links, uuid(1)).remaining).toEqual([{ entryId: uuid(2), tagId: uuid(10) }]);
    const byTag = linksAfterTagDeletion(links, uuid(10));
    expect(byTag.remaining).toEqual([{ entryId: uuid(1), tagId: uuid(11) }]);
    expect(byTag.removed).toHaveLength(2);
  });
});

