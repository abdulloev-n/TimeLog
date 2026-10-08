import type { ProjectInfo } from './entities.ts';
import { ok, type Result } from './result.ts';
import { validateNonNegativeInteger } from './validation.ts';

export type RemovalDecision =
  /** No references. The UI asks for confirmation, then deletes the row. */
  | { readonly action: 'delete-after-confirmation'; readonly message: string }
  /** Referenced. The UI archives instead of deleting. */
  | { readonly action: 'archive'; readonly message: string }
  /** Referenced and archived already. Nothing to do. */
  | { readonly action: 'already-archived'; readonly message: string };

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
}

export type ClientRemovalDecision = RemovalDecision & {
  /** Active projects of this client. Archiving a client never archives them on its own; offer it. */
  readonly activeProjects: readonly ProjectSummary[];
};

export interface ProjectRemovalInput {
  readonly project: { readonly id: string; readonly archived: boolean };
  /** COUNT(*) FROM time_entries WHERE project_id = ? */
  readonly entryReferenceCount: number;
}

export interface ClientRemovalInput {
  readonly client: { readonly id: string; readonly archived: boolean };
  /** All projects, archived included. */
  readonly projects: readonly ProjectInfo[];
  /** COUNT(*) FROM invoices WHERE client_id = ? */
  readonly invoiceReferenceCount: number;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function decideProjectRemoval(input: ProjectRemovalInput): Result<RemovalDecision> {
  const count = validateNonNegativeInteger(input.entryReferenceCount, 'entryReferenceCount');
  if (!count.ok) return count;
  if (count.value === 0) {
    return ok({ action: 'delete-after-confirmation', message: 'This project has no time entries. Delete it permanently?' });
  }
  if (input.project.archived) {
    return ok({ action: 'already-archived', message: 'This project is archived and keeps its history.' });
  }
  return ok({
    action: 'archive',
    message: `This project has ${count.value === 1 ? '1 time entry' : `${count.value} time entries`}, so it will be archived instead of deleted.`,
  });
}

export function decideClientRemoval(input: ClientRemovalInput): Result<ClientRemovalDecision> {
  const invoices = validateNonNegativeInteger(input.invoiceReferenceCount, 'invoiceReferenceCount');
  if (!invoices.ok) return invoices;
  const ownProjects = input.projects.filter((p) => p.clientId === input.client.id);
  const activeProjects = ownProjects
    .filter((p) => !p.archived)
    .map((p) => ({ id: p.id, name: p.name }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (ownProjects.length === 0 && invoices.value === 0) {
    return ok({
      action: 'delete-after-confirmation',
      message: 'This client has no projects or invoices. Delete it permanently?',
      activeProjects,
    });
  }
  if (input.client.archived) {
    return ok({ action: 'already-archived', message: 'This client is archived and keeps its history.', activeProjects });
  }
  const reasons: string[] = [];
  if (ownProjects.length > 0) reasons.push(plural(ownProjects.length, 'project'));
  if (invoices.value > 0) reasons.push(plural(invoices.value, 'invoice'));
  return ok({
    action: 'archive',
    message: `This client has ${reasons.join(' and ')}, so it will be archived instead of deleted.`,
    activeProjects,
  });
}

/** Returns a copy with the archived flag set. The input stays unchanged. */
export function setArchived<T extends { readonly archived: boolean }>(entity: T, archived: boolean): T {
  return { ...entity, archived };
}

export interface EntryTagLink {
  readonly entryId: string;
  readonly tagId: string;
}

export interface LinkRemoval {
  readonly remaining: readonly EntryTagLink[];
  readonly removed: readonly EntryTagLink[];
}

/** Deleting an entry removes its tag links (ON DELETE CASCADE) and nothing else. */
export function linksAfterEntryDeletion(links: readonly EntryTagLink[], entryId: string): LinkRemoval {
  return {
    remaining: links.filter((l) => l.entryId !== entryId),
    removed: links.filter((l) => l.entryId === entryId),
  };
}

/** Deleting a tag removes its links (ON DELETE CASCADE). Entries stay. */
export function linksAfterTagDeletion(links: readonly EntryTagLink[], tagId: string): LinkRemoval {
  return {
    remaining: links.filter((l) => l.tagId !== tagId),
    removed: links.filter((l) => l.tagId === tagId),
  };
}

