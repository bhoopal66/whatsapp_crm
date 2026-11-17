// The "My activity" page's decisions, kept pure so they are tested
// without a DOM. The report and the two lists come from the routes the
// Team activity screen already uses; a leader or admin gets their whole
// team's (or account's) rows back, so everything here narrows to the
// caller: their own person row, their own blocked sends, their own
// unlock requests. RLS decides what reaches the browser; this only
// decides what the page shows as "mine".

import {
  RESTRICTION_RULES,
  type RestrictionRule,
  type SendRestriction,
} from './blocked-send';
import type { SenderActivity, TeamActivityReport } from './report';

/**
 * The caller's own sender row. Agents get a `self` report holding only
 * theirs; leaders and admins get a team or account report, so the row
 * is picked by the auth user id. Never an API or bot row.
 */
export function mySenderRow(
  report: Pick<TeamActivityReport, 'senders'>,
  myUserId: string | null | undefined
): SenderActivity | null {
  if (!myUserId) return null;
  return (
    report.senders.find((s) => s.kind === 'person' && s.userId === myUserId) ??
    null
  );
}

export interface MyBlock {
  id: string;
  rule: string;
  conversationId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export type UnlockStatus =
  'pending' | 'approved' | 'denied' | 'used' | 'expired';

const UNLOCK_STATUSES: readonly UnlockStatus[] = [
  'pending',
  'approved',
  'denied',
  'used',
  'expired',
];

export interface MyUnlock {
  id: string;
  rule: string;
  reason: string;
  status: UnlockStatus;
  decisionNote: string | null;
  expiresAt: string | null;
  createdAt: string;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

function listOf(body: unknown, key: string): Obj[] {
  if (!isObj(body)) return [];
  const list = body[key];
  return Array.isArray(list) ? list.filter(isObj) : [];
}

/** `GET /api/team-activity/blocks` → the caller's own, newest first. */
export function myBlocks(body: unknown, myUserId: string): MyBlock[] {
  const out: MyBlock[] = [];
  for (const b of listOf(body, 'blocks')) {
    const id = str(b.id);
    const rule = str(b.rule);
    const createdAt = str(b.created_at);
    if (!id || !rule || !createdAt || b.user_id !== myUserId) continue;
    out.push({
      id,
      rule,
      conversationId: str(b.conversation_id),
      detail: isObj(b.detail) ? b.detail : {},
      createdAt,
    });
  }
  return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** `GET /api/team-activity/unlocks` → the caller's own, newest first. */
export function myUnlocks(body: unknown, myUserId: string): MyUnlock[] {
  const out: MyUnlock[] = [];
  for (const u of listOf(body, 'unlocks')) {
    const id = str(u.id);
    const createdAt = str(u.created_at);
    const status = UNLOCK_STATUSES.find((s) => s === u.status);
    if (!id || !createdAt || !status || u.requester_id !== myUserId) continue;
    out.push({
      id,
      rule: str(u.rule) ?? '',
      reason: typeof u.reason === 'string' ? u.reason : '',
      status,
      decisionNote: str(u.decision_note),
      expiresAt: str(u.expires_at),
      createdAt,
    });
  }
  return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** How often each rule stopped the caller, most often first. */
export function blocksByRule(
  blocks: readonly Pick<MyBlock, 'rule'>[]
): { rule: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const b of blocks) counts.set(b.rule, (counts.get(b.rule) ?? 0) + 1);
  return [...counts]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
}

/**
 * A stored block (or an unlock's rule, with no detail) in the shape
 * `ruleMessage()` reads. A rule this build does not know gets an empty
 * `error`, so its sentence falls back to the caller's own wording.
 */
export function asRestriction(
  row: Pick<MyBlock, 'id' | 'rule'> & { detail?: Record<string, unknown> }
): SendRestriction {
  return {
    rule: row.rule as RestrictionRule,
    blockId: row.id,
    unlockable: false,
    detail: row.detail ?? {},
    error: '',
  };
}

export function isKnownRule(rule: string): rule is RestrictionRule {
  return (RESTRICTION_RULES as readonly string[]).includes(rule);
}
