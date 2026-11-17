// ============================================================
// The composer's blocked-send card (hard restrictions, migrations
// 204-205). A send the server refuses under a team-activity rule
// answers 429 `{ code: 'restricted', rule, blockId, unlockable,
// detail }`; this module reads that body, names the rule's message
// (a key under TeamActivity.blocked.rule plus its values), and walks
// the card through asking for a one-time unlock. Pure, so it is
// tested without a DOM; the component stays thin.
// ============================================================

export const RESTRICTION_RULES = [
  'chase',
  'quiet_hours',
  'daily_user',
  'daily_user_throttled',
  'daily_number',
  'burst',
  'link_first',
  'same_opener',
  'jev_cold_pitch',
] as const;

export type RestrictionRule = (typeof RESTRICTION_RULES)[number];

export interface SendRestriction {
  rule: RestrictionRule;
  blockId: string;
  unlockable: boolean;
  detail: Record<string, unknown>;
  /** The route's own words, for a rule this build does not know. */
  error: string;
}

/** A reason's length bounds (205's CHECK). */
export const UNLOCK_REASON_MIN = 5;
export const UNLOCK_REASON_MAX = 500;

/** How often the card asks whether its request was decided. */
export const UNLOCK_POLL_MS = 20_000;

function isRule(v: unknown): v is RestrictionRule {
  return (
    typeof v === 'string' &&
    (RESTRICTION_RULES as readonly string[]).includes(v)
  );
}

/**
 * The restriction in a failed send's answer, or null for any other
 * failure (which keeps the ordinary toast). An unknown rule from a
 * newer server is still a restriction; it is worded with the route's
 * own `error`.
 */
export function parseSendRestriction(
  status: number,
  body: unknown
): SendRestriction | null {
  if (status !== 429 || !body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  if (o.code !== 'restricted') return null;
  if (typeof o.blockId !== 'string' || o.blockId.length === 0) return null;
  const detail =
    o.detail && typeof o.detail === 'object' && !Array.isArray(o.detail)
      ? (o.detail as Record<string, unknown>)
      : {};
  return {
    rule: isRule(o.rule) ? o.rule : ('unknown' as RestrictionRule),
    blockId: o.blockId,
    unlockable: o.unlockable === true,
    detail,
    error: typeof o.error === 'string' ? o.error : '',
  };
}

export type RuleMessage =
  | { key: string; values: Record<string, string | number> }
  | { key: null; text: string };

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

function hhmm(v: unknown): string {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 24) {
    return `${String(v).padStart(2, '0')}:00`;
  }
  if (typeof v === 'string' && /^\d{1,2}(:\d{2})?/.test(v)) {
    const [h, m = '00'] = v.split(':');
    return `${h.padStart(2, '0')}:${m.slice(0, 2)}`;
  }
  return '';
}

/**
 * The card's sentence: a message key under TeamActivity.blocked.rule
 * and its values. Figures the server left out fall back to the
 * rule's figure-free sentence (`<rule>Plain`), never to "undefined".
 */
export function ruleMessage(r: SendRestriction): RuleMessage {
  const d = r.detail;
  switch (r.rule) {
    case 'chase': {
      const limit = num(d.limit);
      return limit === null
        ? { key: 'chasePlain', values: {} }
        : { key: 'chase', values: { limit } };
    }
    case 'quiet_hours': {
      const end = hhmm(d.end);
      return end
        ? { key: 'quietHours', values: { end } }
        : { key: 'quietHoursPlain', values: {} };
    }
    case 'daily_user':
    case 'daily_user_throttled': {
      const limit = num(d.limit);
      const rate = num(d.reply_rate);
      if (limit === null) return { key: 'dailyUserPlain', values: {} };
      if (r.rule === 'daily_user_throttled') {
        return rate === null
          ? { key: 'dailyUserThrottledPlain', values: { limit } }
          : {
              key: 'dailyUserThrottled',
              values: { limit, rate: Math.round(rate) },
            };
      }
      return { key: 'dailyUser', values: { limit } };
    }
    case 'daily_number': {
      const limit = num(d.limit);
      if (limit === null) return { key: 'dailyNumberPlain', values: {} };
      return {
        key: d.warming_up === true ? 'dailyNumberWarmingUp' : 'dailyNumber',
        values: { limit },
      };
    }
    case 'burst': {
      const limit = num(d.limit);
      const wait = num(d.retry_after_s);
      if (limit === null) return { key: 'burstPlain', values: {} };
      return {
        key: 'burst',
        values: {
          limit,
          minutes: Math.max(1, Math.ceil((wait ?? 600) / 60)),
        },
      };
    }
    case 'link_first':
      return { key: 'linkFirst', values: {} };
    case 'same_opener': {
      const count = num(d.count);
      return count === null
        ? { key: 'sameOpenerPlain', values: {} }
        : { key: 'sameOpener', values: { count } };
    }
    case 'jev_cold_pitch':
      return { key: 'jevColdPitch', values: {} };
    default:
      return { key: null, text: r.error };
  }
}

// ---------- the card's states ----------

export type UnlockCardState =
  | { phase: 'blocked' }
  | { phase: 'asking'; reason: string }
  | { phase: 'submitting'; reason: string }
  | { phase: 'waiting'; requestId: string }
  | { phase: 'approved'; expiresAt: string | null }
  | { phase: 'denied'; note: string | null }
  | { phase: 'expired' };

export type UnlockCardEvent =
  | { type: 'ask' }
  | { type: 'edit'; reason: string }
  | { type: 'cancel' }
  | { type: 'submit' }
  | { type: 'submitted'; requestId: string }
  | { type: 'submitFailed' }
  | { type: 'decided'; row: UnlockRow };

export interface UnlockRow {
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'used' | 'expired';
  expiresAt: string | null;
  note: string | null;
}

/** Whether a reason may be sent: 5-500 characters, not blank. */
export function reasonValid(reason: string): boolean {
  const t = reason.trim();
  return t.length >= UNLOCK_REASON_MIN && reason.length <= UNLOCK_REASON_MAX;
}

export function unlockCardReducer(
  state: UnlockCardState,
  event: UnlockCardEvent
): UnlockCardState {
  switch (event.type) {
    case 'ask':
      return state.phase === 'blocked'
        ? { phase: 'asking', reason: '' }
        : state;
    case 'edit':
      return state.phase === 'asking'
        ? { phase: 'asking', reason: event.reason.slice(0, UNLOCK_REASON_MAX) }
        : state;
    case 'cancel':
      return state.phase === 'asking' ? { phase: 'blocked' } : state;
    case 'submit':
      return state.phase === 'asking' && reasonValid(state.reason)
        ? { phase: 'submitting', reason: state.reason }
        : state;
    case 'submitted':
      return state.phase === 'submitting'
        ? { phase: 'waiting', requestId: event.requestId }
        : state;
    case 'submitFailed':
      return state.phase === 'submitting'
        ? { phase: 'asking', reason: state.reason }
        : state;
    case 'decided': {
      if (state.phase !== 'waiting' || event.row.id !== state.requestId) {
        return state;
      }
      switch (event.row.status) {
        case 'approved':
          return { phase: 'approved', expiresAt: event.row.expiresAt };
        case 'denied':
          return { phase: 'denied', note: event.row.note };
        case 'expired':
        case 'used':
          return { phase: 'expired' };
        default:
          return state;
      }
    }
  }
}

/** One request out of GET /api/team-activity/unlocks, or null. */
export function findUnlockRow(body: unknown, id: string): UnlockRow | null {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? ((body as Record<string, unknown>).unlocks ??
        (body as Record<string, unknown>).data)
      : null;
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (o.id !== id) continue;
    const status = o.status;
    if (
      status !== 'pending' &&
      status !== 'approved' &&
      status !== 'denied' &&
      status !== 'used' &&
      status !== 'expired'
    ) {
      return null;
    }
    // An approval past its time reads as expired (S6).
    const expiresAt =
      typeof o.expires_at === 'string'
        ? o.expires_at
        : typeof o.expiresAt === 'string'
          ? o.expiresAt
          : null;
    const note =
      typeof o.decision_note === 'string'
        ? o.decision_note
        : typeof o.decisionNote === 'string'
          ? o.decisionNote
          : null;
    return { id, status, expiresAt, note };
  }
  return null;
}

/**
 * The card belongs to one chat. Keyed by conversation id, so opening
 * another chat shows that chat's card (or none) and coming back
 * restores this one; a decided-and-dismissed card is dropped.
 */
export type BlockedCards = Readonly<
  Record<string, { restriction: SendRestriction; state: UnlockCardState }>
>;

export function cardFor(
  cards: BlockedCards,
  conversationId: string | null | undefined
) {
  return conversationId ? (cards[conversationId] ?? null) : null;
}
