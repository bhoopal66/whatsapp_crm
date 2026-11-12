/**
 * The Daily digest page's pure parts (package 022e): the answer parser,
 * the fixed section order, case links, the request URL and the "View as"
 * choices. Dependency-free on purpose (type-only imports): a client
 * component imports it, and lib/brain/digest.ts is server code. The
 * server re-checks every rule; "View as" is a view filter, not an action.
 */
import type { DigestItem, DigestSectionKind } from './digest';

/** The page's section order; a section the server leaves out shows empty. */
export const DIGEST_ORDER: readonly DigestSectionKind[] = [
  'stale_cases',
  'promises',
  'related',
  'followups',
];

export interface DigestViewSection {
  kind: DigestSectionKind;
  items: DigestItem[];
}

export interface DigestView {
  generatedAt: string;
  aiGenerated: boolean;
  sections: DigestViewSection[];
}

const CITATION_KINDS = ['case', 'message', 'task'] as const;

function parseItem(raw: unknown): DigestItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const i = raw as Record<string, unknown>;
  if (
    typeof i.caseId !== 'string' ||
    i.caseId === '' ||
    typeof i.label !== 'string' ||
    typeof i.reason !== 'string'
  )
    return null;
  const item: DigestItem = {
    caseId: i.caseId,
    label: i.label,
    reason: i.reason,
  };
  const c = i.citation as Record<string, unknown> | null | undefined;
  if (
    c &&
    typeof c === 'object' &&
    typeof c.id === 'string' &&
    (CITATION_KINDS as readonly unknown[]).includes(c.kind)
  )
    item.citation = {
      kind: c.kind as (typeof CITATION_KINDS)[number],
      id: c.id,
    };
  return item;
}

/**
 * `GET /api/brain/digest` body -> the four sections in DIGEST_ORDER, or
 * null on a bad shape. Unknown sections and malformed items are dropped;
 * a missing section comes back empty; a repeated kind keeps the first.
 */
export function parseDigest(body: unknown): DigestView | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.generatedAt !== 'string' || !Array.isArray(b.sections))
    return null;
  const byKind = new Map<DigestSectionKind, DigestItem[]>();
  for (const raw of b.sections) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    const kind = s.kind as DigestSectionKind;
    if (!DIGEST_ORDER.includes(kind) || byKind.has(kind)) continue;
    const items = Array.isArray(s.items) ? s.items : [];
    byKind.set(
      kind,
      items.map(parseItem).filter((x): x is DigestItem => x !== null)
    );
  }
  return {
    generatedAt: b.generatedAt,
    aiGenerated: b.aiGenerated === true,
    sections: DIGEST_ORDER.map((kind) => ({
      kind,
      items: byKind.get(kind) ?? [],
    })),
  };
}

/** An item's link: its case page. */
export function digestItemHref(caseId: string): string {
  return `/cases/${encodeURIComponent(caseId)}`;
}

/** The digest request: the caller's own, or a teammate's (`?userId=`). */
export function digestUrl(viewAs: string | null | undefined): string {
  return viewAs
    ? `/api/brain/digest?userId=${encodeURIComponent(viewAs)}`
    : '/api/brain/digest';
}

export interface ViewAsMember {
  user_id: string;
  full_name?: string | null;
  email?: string | null;
  deactivated_at?: string | null;
}

/**
 * "View as" choices: every live teammate but the viewer, by name (the
 * route 404s a deactivated one). Names fall back to the email.
 */
export function viewAsOptions(
  members: readonly ViewAsMember[],
  meId: string | null | undefined
): { userId: string; name: string }[] {
  return members
    .filter((m) => m.user_id && m.user_id !== meId && !m.deactivated_at)
    .map((m) => ({
      userId: m.user_id,
      name: m.full_name?.trim() || m.email || m.user_id,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
