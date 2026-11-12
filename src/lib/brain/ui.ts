/**
 * The Brain search page's pure parts (package 022e): query validation,
 * the answer parser, case links and the remember box's case choices.
 * Dependency-free on purpose: a client component imports it, and every
 * other module under lib/brain pulls in the service role or node:crypto.
 * The server re-checks every rule.
 */
import type { BrainSourceKind } from './ports';

export const BRAIN_QUERY_MIN = 2;
export const BRAIN_QUERY_MAX = 300;
/** `POST /api/brain/remember` takes 1-4000 characters. */
export const BRAIN_REMEMBER_MAX = 4000;

/** Mirrors `BRAIN_SOURCE_KINDS` (ports.ts, type-only for the client). */
export const BRAIN_UI_SOURCE_KINDS: readonly BrainSourceKind[] = [
  'message',
  'note',
  'timeline',
  'pinned',
  'discussion',
  'remember',
  'page',
];

/** One search hit as the page shows it; the score is never shown. */
export interface BrainUiHit {
  itemId: string;
  snippet: string;
  sourceKind: BrainSourceKind;
  caseId: string | null;
  aiGenerated: boolean;
}

/** null when the query may be sent; the API allows 1-300, the page asks for 2. */
export function queryProblem(query: string): 'short' | 'long' | null {
  const q = query.trim();
  if (q.length < BRAIN_QUERY_MIN) return 'short';
  if (q.length > BRAIN_QUERY_MAX) return 'long';
  return null;
}

/** Citation link of a hit: its case page; a workspace item has none. */
export function hitHref(hit: Pick<BrainUiHit, 'caseId'>): string | null {
  return hit.caseId === null
    ? null
    : `/cases/${encodeURIComponent(hit.caseId)}`;
}

/** Cases the remember box can attach to: the scoped case first, then the hits' cases, distinct. */
export function rememberCaseOptions(
  hits: readonly Pick<BrainUiHit, 'caseId'>[],
  scopedCaseId?: string | null
): string[] {
  const out: string[] = scopedCaseId ? [scopedCaseId] : [];
  for (const h of hits)
    if (h.caseId !== null && !out.includes(h.caseId)) out.push(h.caseId);
  return out;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `?case=` scope, only when it is a UUID (the API refuses anything else). */
export function parseCaseScope(
  value: string | null | undefined
): string | null {
  const v = value?.trim() ?? '';
  return UUID_RE.test(v) ? v : null;
}

/** `{hits: [...]}` from `POST /api/brain/search` -> hits, or null on a bad shape. Bad rows are dropped. */
export function parseSearchHits(body: unknown): BrainUiHit[] | null {
  const hits =
    body && typeof body === 'object'
      ? (body as Record<string, unknown>).hits
      : null;
  if (!Array.isArray(hits)) return null;
  const out: BrainUiHit[] = [];
  for (const raw of hits) {
    if (!raw || typeof raw !== 'object') continue;
    const h = raw as Record<string, unknown>;
    if (
      typeof h.itemId !== 'string' ||
      typeof h.snippet !== 'string' ||
      !BRAIN_UI_SOURCE_KINDS.includes(h.sourceKind as BrainSourceKind) ||
      !(h.caseId === null || typeof h.caseId === 'string')
    )
      continue;
    out.push({
      itemId: h.itemId,
      snippet: h.snippet,
      sourceKind: h.sourceKind as BrainSourceKind,
      caseId: h.caseId,
      aiGenerated: h.aiGenerated === true,
    });
  }
  return out;
}

/** True when an API answer is the "brain is switched off" refusal. */
export function isBrainDisabled(status: number, body: unknown): boolean {
  return (
    status === 403 &&
    !!body &&
    typeof body === 'object' &&
    (body as Record<string, unknown>).error === 'brain_disabled'
  );
}
