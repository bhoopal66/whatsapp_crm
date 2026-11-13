// ============================================================
// Settings → Phone extensions: the pure half of the mapping page.
//
// Everything here works on GET /api/pbx/extensions (+ the sync's
// caller ID names) and decides nothing the server does not re-check:
// the PATCH route and pbx_extensions_guard (089) still refuse a person
// who is not live staff of the extension's workspace, and the
// one-extension-per-person index answers 409.
// ============================================================

import type { MappableWorkspace, PbxExtensionView } from './admin-ui';

type Ext = Pick<
  PbxExtensionView,
  'id' | 'extension' | 'accountId' | 'userId' | 'mapped' | 'personName'
> & { callerIdName?: string | null };

/**
 * Lower case, accents and punctuation dropped, spaces collapsed. Letters
 * of any script stay (Arabic names match Arabic names).
 */
export function normalizeName(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokens(s: string | null | undefined): string[] {
  const n = normalizeName(s);
  return n ? n.split(' ') : [];
}

/** Who in the extension's workspace already holds which extension. */
function holders(extensions: readonly Ext[]): Map<string, Ext> {
  const out = new Map<string, Ext>();
  for (const e of extensions)
    if (e.userId) out.set(`${e.accountId}:${e.userId}`, e);
  return out;
}

/**
 * How well a PBX caller ID name fits a person: 3 the same name, 2 the
 * same first and last word, 1 a one-word PBX name equal to the person's
 * first word; 0 no fit.
 */
export function nameScore(
  pbxName: string | null | undefined,
  personName: string | null | undefined
): 0 | 1 | 2 | 3 {
  const a = tokens(pbxName);
  const b = tokens(personName);
  if (a.length === 0 || b.length === 0) return 0;
  if (a.join(' ') === b.join(' ')) return 3;
  if (
    a.length >= 2 &&
    b.length >= 2 &&
    a[0] === b[0] &&
    a[a.length - 1] === b[b.length - 1]
  )
    return 2;
  if (a.length === 1 && a[0].length >= 3 && a[0] === b[0]) return 1;
  return 0;
}

export interface MappingSuggestion {
  extensionId: string;
  userId: string;
  name: string;
}

/**
 * One suggested person per unlinked extension, from the PBX's caller ID
 * name. Only people of that workspace who hold no extension there are
 * candidates, a suggestion must be the single best fit for the
 * extension, and a person fitting two extensions equally is suggested
 * for neither: a wrong link is worse than none.
 */
export function suggestMappings(
  extensions: readonly Ext[],
  workspaces: readonly MappableWorkspace[]
): MappingSuggestion[] {
  const held = holders(extensions);
  const picks: (MappingSuggestion & { score: number })[] = [];
  for (const ext of extensions) {
    if (ext.mapped || !ext.callerIdName) continue;
    const ws = workspaces.find((w) => w.accountId === ext.accountId);
    if (!ws) continue;
    // Everyone competes, holders included: a namesake who already holds
    // an extension makes the name ambiguous (this may be their second
    // line), so it blocks the suggestion rather than handing it to the
    // other person with that name.
    let best = 0;
    let found: { userId: string; name: string }[] = [];
    for (const p of ws.people) {
      const s = nameScore(ext.callerIdName, p.name);
      if (s === 0 || s < best) continue;
      if (s > best) {
        best = s;
        found = [];
      }
      found.push({ userId: p.userId, name: p.name ?? '' });
    }
    if (found.length === 1 && !held.has(`${ws.accountId}:${found[0].userId}`))
      picks.push({ extensionId: ext.id, ...found[0], score: best });
  }
  // A person fitting several extensions keeps only a strictly better one.
  return picks
    .filter(
      (s) =>
        !picks.some(
          (o) => o !== s && o.userId === s.userId && o.score >= s.score
        )
    )
    .map(({ extensionId, userId, name }) => ({ extensionId, userId, name }));
}

export type ExtensionFilter = 'all' | 'unlinked' | 'linked';

/** The rows the search box and the filter chips leave, in number order. */
export function filterExtensions<T extends Ext>(
  rows: readonly T[],
  query: string,
  filter: ExtensionFilter
): T[] {
  const q = normalizeName(query);
  const digits = query.replace(/\D/g, '');
  return rows
    .filter((r) =>
      filter === 'all' ? true : filter === 'linked' ? r.mapped : !r.mapped
    )
    .filter(
      (r) =>
        !q ||
        (digits !== '' && r.extension.includes(digits)) ||
        normalizeName(r.extension).includes(q) ||
        normalizeName(r.callerIdName).includes(q) ||
        normalizeName(r.personName).includes(q)
    )
    .sort((a, b) =>
      a.extension.localeCompare(b.extension, undefined, { numeric: true })
    );
}

export interface PersonRow {
  userId: string;
  name: string | null;
  accountId: string;
  workspaceName: string;
  extension: Ext | null;
}

/**
 * Every person who may hold an extension, in each workspace the caller
 * administers, with the extension they hold there. People without one
 * first, then by name.
 */
export function peopleRows(
  extensions: readonly Ext[],
  workspaces: readonly MappableWorkspace[]
): PersonRow[] {
  const held = holders(extensions);
  const rows: PersonRow[] = [];
  for (const ws of workspaces)
    for (const p of ws.people)
      rows.push({
        userId: p.userId,
        name: p.name,
        accountId: ws.accountId,
        workspaceName: ws.name,
        extension: held.get(`${ws.accountId}:${p.userId}`) ?? null,
      });
  return rows.sort(
    (a, b) =>
      Number(a.extension !== null) - Number(b.extension !== null) ||
      (a.name ?? '').localeCompare(b.name ?? '')
  );
}

export interface PersonOption {
  userId: string;
  name: string | null;
  /** The extension number they hold in this workspace, if another one. */
  holds: string | null;
  /** The extension id they hold, so a pick can unlink it first. */
  holdsId: string | null;
}

/** Who the person picker on one extension offers. */
export function personOptions(
  ext: Ext,
  extensions: readonly Ext[],
  workspaces: readonly MappableWorkspace[]
): PersonOption[] {
  const ws = workspaces.find((w) => w.accountId === ext.accountId);
  if (!ws) return [];
  const held = holders(extensions);
  return ws.people
    .map((p) => {
      const h = held.get(`${ws.accountId}:${p.userId}`);
      const other = h && h.id !== ext.id ? h : null;
      return {
        userId: p.userId,
        name: p.name,
        holds: other?.extension ?? null,
        holdsId: other?.id ?? null,
      };
    })
    .sort(
      (a, b) =>
        Number(a.holds !== null) - Number(b.holds !== null) ||
        (a.name ?? '').localeCompare(b.name ?? '')
    );
}

/** The unlinked extensions of a workspace, for the By person picker. */
export function freeExtensions<T extends Ext>(
  extensions: readonly T[],
  accountId: string
): T[] {
  return extensions
    .filter((e) => e.accountId === accountId && !e.mapped)
    .sort((a, b) =>
      a.extension.localeCompare(b.extension, undefined, { numeric: true })
    );
}

export interface MappingSummary {
  total: number;
  linked: number;
  unlinked: number;
  peopleWithout: number;
}

/** The header counts, over the workspaces the caller administers. */
export function mappingSummary(
  extensions: readonly Ext[],
  workspaces: readonly MappableWorkspace[]
): MappingSummary {
  const mine = new Set(workspaces.map((w) => w.accountId));
  const own = extensions.filter((e) => mine.has(e.accountId));
  const linked = own.filter((e) => e.mapped).length;
  return {
    total: own.length,
    linked,
    unlinked: own.length - linked,
    peopleWithout: peopleRows(extensions, workspaces).filter(
      (r) => r.extension === null
    ).length,
  };
}

export interface PlannedLink {
  extensionId: string;
  userId: string | null;
}

/**
 * The PATCHes that put `userId` on extension `extensionId` (or take the
 * person off it, for null), in the order they must run. A person who
 * already holds another extension in that workspace is unlinked from it
 * first: the one-extension-per-person index would answer 409 otherwise.
 * Nothing to do is an empty list.
 */
export function planLink(
  extensionId: string,
  userId: string | null,
  extensions: readonly Ext[]
): PlannedLink[] {
  const target = extensions.find((e) => e.id === extensionId);
  if (!target) return [];
  if (userId === null)
    return target.mapped || target.userId
      ? [{ extensionId, userId: null }]
      : [];
  if (target.userId === userId) return [];
  const held = extensions.find(
    (e) =>
      e.id !== extensionId &&
      e.accountId === target.accountId &&
      e.userId === userId
  );
  return [
    ...(held ? [{ extensionId: held.id, userId: null }] : []),
    { extensionId, userId },
  ];
}

/**
 * Whether a suggestion made earlier may still be applied as it is: the
 * extension is still unlinked and the person still holds no extension in
 * its workspace. Link all re-checks every suggestion against the newest
 * rows with this, so a link made by hand meanwhile is never overwritten
 * and nobody is ever moved (a move is a pick, never a batch).
 */
export function suggestionStillValid(
  s: Pick<MappingSuggestion, 'extensionId' | 'userId'>,
  extensions: readonly Ext[]
): boolean {
  const target = extensions.find((e) => e.id === s.extensionId);
  if (!target || target.mapped || target.userId) return false;
  return !extensions.some(
    (e) => e.accountId === target.accountId && e.userId === s.userId
  );
}

/**
 * The rows after a PBX sync. The sync's rows win (they add extensions the
 * PBX gained), except where `keepLocal` says this page wrote the row while
 * the sync was out or still is: the sync read the row before that write,
 * so it keeps its own state and takes only the PBX's name.
 */
export function mergeSynced<
  T extends { id: string; callerIdName?: string | null; onPbx?: boolean },
>(
  prev: readonly T[],
  synced: readonly T[],
  keepLocal: (id: string) => boolean
): T[] {
  return synced.map((n) => {
    const cur = prev.find((r) => r.id === n.id);
    return cur && keepLocal(n.id)
      ? { ...cur, callerIdName: n.callerIdName, onPbx: n.onPbx }
      : n;
  });
}
