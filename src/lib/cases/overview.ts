/**
 * The case page's Overview lead row: how far the document checklist is,
 * what to do next, and the customer's last message. Pure: the components
 * own the fetching.
 */

import { allowedNextStages, isFinalStage } from './case-page';
import type { CaseRecord } from './case-page';

export interface DocsSummary {
  /** Documents the case requires. */
  required: number;
  received: number;
  rejected: number;
  /** Labels still to come (not received), in checklist order. */
  missing: string[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;

/** GET /api/cases/[id]/documents, reduced to counts; null when unreadable. */
export function summariseDocs(json: unknown): DocsSummary | null {
  const root = obj(json);
  if (!root || !Array.isArray(root.items)) return null;
  const rows = root.items
    .map(obj)
    .filter((r): r is Obj => r !== null && typeof r.docKey === 'string')
    .sort(
      (a, b) =>
        (typeof a.position === 'number' ? a.position : 0) -
        (typeof b.position === 'number' ? b.position : 0)
    );
  const status = (r: Obj) => (typeof r.status === 'string' ? r.status : null);
  const label = (r: Obj) =>
    typeof r.label === 'string' && r.label ? r.label : String(r.docKey);
  return {
    required: rows.length,
    received: rows.filter((r) => status(r) === 'received').length,
    rejected: rows.filter((r) => status(r) === 'rejected').length,
    missing: rows.filter((r) => status(r) !== 'received').map(label),
  };
}

/** The checklist read: its counts, or why there are none. */
export type DocsRead = DocsSummary | 'loading' | 'failed';

export type NextStep =
  | { kind: 'loading' }
  | { kind: 'docsFailed' }
  /** The stage is Compass's (134), or the caller may not write. */
  | { kind: 'locked' }
  | { kind: 'readOnly' }
  | { kind: 'closed' }
  | { kind: 'documents'; missing: number; rejected: number }
  | { kind: 'move'; stage: string }
  | { kind: 'none' };

/**
 * One line of guidance. A closed case needs nothing; missing documents
 * come first (they hold every bank stage up); otherwise the next stage
 * in the bank's own list after the current one, when a move is allowed.
 * Nothing is advised before the checklist is known, and no move to
 * someone the server would refuse (`may`, as the Move stage button has it).
 */
export function nextStep(
  c: Pick<CaseRecord, 'stage' | 'groupId' | 'closedAt'>,
  stages: readonly string[],
  docs: DocsRead,
  may: { canWrite: boolean; stageLocked: boolean }
): NextStep {
  if (c.closedAt !== null || isFinalStage(c.stage)) return { kind: 'closed' };
  if (docs === 'loading') return { kind: 'loading' };
  if (docs === 'failed') return { kind: 'docsFailed' };
  if (docs.missing.length > 0)
    return {
      kind: 'documents',
      missing: docs.missing.length,
      rejected: docs.rejected,
    };
  if (may.stageLocked) return { kind: 'locked' };
  if (!may.canWrite) return { kind: 'readOnly' };
  const allowed = allowedNextStages(c, stages);
  const here = stages.indexOf(c.stage);
  const next = stages.slice(here + 1).find((s) => allowed.includes(s));
  return next ? { kind: 'move', stage: next } : { kind: 'none' };
}

export interface LastMessage {
  conversationId: string;
  /** Trimmed text, or null for a message with no text (media). */
  text: string | null;
  at: string;
}

export const SNIPPET_MAX = 200;

/** The text shortened to a snippet at a word edge where one is near. */
export function snippet(text: string, max = SNIPPET_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The last-message route's body; null for none or a malformed one. */
export function parseLastMessage(json: unknown): LastMessage | null {
  const m = obj(obj(json)?.message);
  if (!m) return null;
  if (typeof m.conversationId !== 'string' || typeof m.at !== 'string')
    return null;
  return {
    conversationId: m.conversationId,
    text: typeof m.text === 'string' && m.text.trim() ? m.text : null,
    at: m.at,
  };
}
