// ============================================================
// The Team activity page's "Blocked sends" and "Unlock requests"
// tabs (migrations 204-205). Parses the two list routes defensively,
// groups blocks by rule and person, orders requests (pending first),
// applies a decision optimistically and names a decision failure.
// Pure, so it is tested without a DOM; the components stay thin.
// ============================================================

import {
  ruleMessage,
  type RestrictionRule,
  type RuleMessage,
} from './blocked-send';

export type TeamActivityTab = 'overview' | 'blocks' | 'unlocks';

/** The tab a `?tab=` value opens; anything else is the overview. */
export function tabFromParam(
  value: string | null | undefined
): TeamActivityTab {
  return value === 'blocks' || value === 'unlocks' ? value : 'overview';
}

export interface TeamBlock {
  id: string;
  userId: string | null;
  conversationId: string | null;
  channelId: string | null;
  rule: string;
  source: 'human' | 'auto';
  detail: Record<string, unknown>;
  createdAt: string;
}

export type UnlockStatus =
  'pending' | 'approved' | 'denied' | 'used' | 'expired';

export interface UnlockRequest {
  id: string;
  blockId: string | null;
  requesterId: string | null;
  conversationId: string | null;
  rule: string;
  reason: string;
  status: UnlockStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  expiresAt: string | null;
  usedAt: string | null;
  createdAt: string;
}

const UNLOCK_STATUSES: readonly UnlockStatus[] = [
  'pending',
  'approved',
  'denied',
  'used',
  'expired',
];

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

function listOf(body: unknown, key: string): unknown[] {
  if (!body || typeof body !== 'object') return [];
  const list = (body as Record<string, unknown>)[key];
  return Array.isArray(list) ? list : [];
}

/** GET /api/team-activity/blocks → rows; malformed items are dropped. */
export function parseBlocks(body: unknown): TeamBlock[] {
  const out: TeamBlock[] = [];
  for (const item of listOf(body, 'blocks')) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = str(o.id);
    const rule = str(o.rule);
    const createdAt = str(o.created_at);
    if (!id || !rule || !createdAt) continue;
    out.push({
      id,
      userId: str(o.user_id),
      conversationId: str(o.conversation_id),
      channelId: str(o.channel_id),
      rule,
      source: o.source === 'auto' ? 'auto' : 'human',
      detail:
        o.detail && typeof o.detail === 'object' && !Array.isArray(o.detail)
          ? (o.detail as Record<string, unknown>)
          : {},
      createdAt,
    });
  }
  return out;
}

/** GET /api/team-activity/unlocks → rows; malformed items are dropped. */
export function parseUnlocks(body: unknown): UnlockRequest[] {
  const out: UnlockRequest[] = [];
  for (const item of listOf(body, 'unlocks')) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = str(o.id);
    const createdAt = str(o.created_at);
    const status = o.status as UnlockStatus;
    if (!id || !createdAt || !UNLOCK_STATUSES.includes(status)) continue;
    out.push({
      id,
      blockId: str(o.block_id),
      requesterId: str(o.requester_id),
      conversationId: str(o.conversation_id),
      rule: str(o.rule) ?? '',
      reason: typeof o.reason === 'string' ? o.reason : '',
      status,
      decidedBy: str(o.decided_by),
      decidedAt: str(o.decided_at),
      decisionNote: str(o.decision_note),
      expiresAt: str(o.expires_at),
      usedAt: str(o.used_at),
      createdAt,
    });
  }
  return out;
}

/** The sentence for a block's rule; an unknown rule keeps its name. */
export function blockRuleMessage(
  rule: string,
  detail: Record<string, unknown>
): RuleMessage {
  return ruleMessage({
    rule: rule as RestrictionRule,
    blockId: '',
    unlockable: false,
    detail,
    error: rule,
  });
}

export interface BlockCount<K> {
  key: K;
  count: number;
}

/** A person's row: their auth user id, or 'auto' for automatic sends. */
export type BlockPersonKey = string | 'auto';

export interface BlockSummary {
  total: number;
  byRule: BlockCount<string>[];
  byPerson: BlockCount<BlockPersonKey>[];
}

function countBy<K extends string>(
  rows: readonly TeamBlock[],
  keyOf: (b: TeamBlock) => K
): BlockCount<K>[] {
  const counts = new Map<K, number>();
  for (const b of rows) {
    const k = keyOf(b);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** Counts by rule and by person, most first (ties by key, stable). */
export function summarizeBlocks(blocks: readonly TeamBlock[]): BlockSummary {
  return {
    total: blocks.length,
    byRule: countBy(blocks, (b) => b.rule),
    byPerson: countBy(blocks, (b) =>
      b.source === 'auto' ? 'auto' : (b.userId ?? 'auto')
    ),
  };
}

/** Newest first. */
export function sortBlocks(blocks: readonly TeamBlock[]): TeamBlock[] {
  return [...blocks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** How many decided requests the tab lists under the pending ones. */
export const RECENT_DECIDED_LIMIT = 30;

/**
 * Pending requests first, the longest-waiting at the top; then the
 * decided ones, the latest decision first.
 */
export function orderUnlocks(unlocks: readonly UnlockRequest[]): {
  pending: UnlockRequest[];
  decided: UnlockRequest[];
} {
  const pending = unlocks
    .filter((u) => u.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const decided = unlocks
    .filter((u) => u.status !== 'pending')
    .sort((a, b) =>
      (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt)
    )
    .slice(0, RECENT_DECIDED_LIMIT);
  return { pending, decided };
}

export function pendingCount(unlocks: readonly UnlockRequest[]): number {
  return unlocks.filter((u) => u.status === 'pending').length;
}

/** The list with one pending request decided, before the server says so. */
export function applyDecision(
  unlocks: readonly UnlockRequest[],
  id: string,
  approve: boolean,
  note: string | null,
  at: string
): UnlockRequest[] {
  return unlocks.map((u) =>
    u.id === id && u.status === 'pending'
      ? {
          ...u,
          status: approve ? 'approved' : 'denied',
          decidedAt: at,
          decisionNote: note,
        }
      : u
  );
}

export type DecisionFailure = 'conflict' | 'forbidden' | 'notFound' | 'failed';

/** Why POST /api/team-activity/unlocks/[id] refused, in the tab's terms. */
export function decisionFailure(status: number): DecisionFailure {
  if (status === 409) return 'conflict';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notFound';
  return 'failed';
}

/** A decision note's bound (the route takes at most 500 characters). */
export const DECISION_NOTE_MAX = 500;

/**
 * The figures of a block for a team leader or admin, who read about
 * someone else: the composer's sentences (TeamActivity.blocked.rule)
 * say "you". Returns the message key under TeamActivity.blocksTab and
 * its values, or null when the block carries no figures.
 */
export function blockFigures(
  rule: string,
  detail: Record<string, unknown>
): { key: 'figures' | 'jevFigure'; values: Record<string, number> } | null {
  const num = (k: string) =>
    typeof detail[k] === 'number' && Number.isFinite(detail[k])
      ? (detail[k] as number)
      : null;
  if (rule === 'jev_cold_pitch') {
    const p = num('p');
    return p === null
      ? null
      : { key: 'jevFigure', values: { p: Math.round(p * 100) } };
  }
  const limit = num('limit');
  const count = num('started') ?? num('steps') ?? num('count');
  return limit === null || count === null
    ? null
    : { key: 'figures', values: { count, limit } };
}
