// ============================================================
// The composer's outreach warnings: what an employee should know
// before the next message goes out on a Whapi number.
//
//   - the next message would START a chat (nothing in the thread for
//     24 hours, and the customer did not write last) and they are at,
//     or near, their daily new-chat limit, or the number is at its own;
//   - the contact has not answered the last N messages;
//   - a tip when the chat is with someone who never wrote to us.
//
// The thread's loaded messages answer the first two questions; the
// day's counts come from team_activity_my_day (migration 068). Pure,
// so it is tested without a DOM. Meta numbers get nothing: the
// restriction risk this guards against is the unofficial (Whapi) one,
// and a Meta number cannot start a chat without an approved template.
//
// "At the limit" is >= everywhere (D5), and a phone number younger
// than WARM_UP_DAYS has the tighter warm-up limit (D6). The number's
// age comes from team_activity_my_day's effective_daily_limit when the
// SQL sends it, else from the number's created_at, which the caller
// passes in (`numberCreatedAt`; useAccountNumbers must select it).
// ============================================================

import { effectiveNumberLimit, isWarmingUp } from './limits';

/** The day's figures, from team_activity_my_day. */
export interface MyOutreachDay {
  /** Chats this person started today. */
  started: number;
  /**
   * Chats each number started today, everyone together, and the limit
   * that applies to it today when the SQL says (migration 073).
   */
  numbers: Array<{
    channelId: string;
    started: number;
    effectiveLimit?: number | null;
    warmingUp?: boolean | null;
  }>;
  limits: {
    dailyNewChatsPerUser: number;
    dailyNewChatsPerNumber: number;
    maxUnansweredInRow: number;
  };
  /** Whether a send past the limit is refused for this person. */
  blockedWhenOver: boolean;
}

export interface ThreadMessageLike {
  sender_type: string;
  created_at: string;
  status?: string | null;
}

export type OutreachNotice =
  | {
      kind: 'limit_reached';
      severity: 'critical';
      started: number;
      limit: number;
      blocked: boolean;
    }
  | { kind: 'limit_near'; severity: 'warning'; started: number; limit: number }
  | {
      kind: 'number_limit';
      severity: 'critical';
      started: number;
      /** The effective limit: the warm-up one while warmingUp. */
      limit: number;
      blocked: boolean;
      /** The number is new and on its warm-up limit (D6). */
      warmingUp: boolean;
    }
  | { kind: 'unanswered'; severity: 'warning'; count: number; max: number }
  | { kind: 'new_contact_tip'; severity: 'info' };

const DAY_MS = 24 * 60 * 60 * 1000;
/** Share of the daily limit from which the warning shows. */
const NEAR_SHARE = 0.8;

/** Parse the RPC's jsonb; null when it is not the expected shape. */
export function parseMyOutreachDay(raw: unknown): MyOutreachDay | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const limits = (o.limits ?? {}) as Record<string, unknown>;
  const int = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  if (typeof o.started !== 'number') return null;
  return {
    started: o.started,
    numbers: Array.isArray(o.numbers)
      ? o.numbers
          .map((n) => n as Record<string, unknown>)
          .filter((n) => typeof n.channel_id === 'string')
          .map((n) => ({
            channelId: n.channel_id as string,
            started: int(n.started, 0),
            effectiveLimit:
              typeof n.effective_daily_limit === 'number' &&
              Number.isFinite(n.effective_daily_limit)
                ? n.effective_daily_limit
                : null,
            warmingUp: typeof n.warming_up === 'boolean' ? n.warming_up : null,
          }))
      : [],
    limits: {
      dailyNewChatsPerUser: int(limits.daily_new_chats_per_user, 20),
      dailyNewChatsPerNumber: int(limits.daily_new_chats_per_number, 50),
      maxUnansweredInRow: int(limits.max_unanswered_in_row, 3),
    },
    blockedWhenOver: o.blocked_when_over === true,
  };
}

/** Whether a message reached (or may have reached) the customer. */
function counts(m: ThreadMessageLike): boolean {
  return m.status !== 'failed';
}

/**
 * Outbound messages since the customer last wrote, newest backwards;
 * every message when the customer never did.
 */
export function unansweredRun(messages: readonly ThreadMessageLike[]): number {
  const sorted = [...messages].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
  );
  let run = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const m = sorted[i];
    if (m.sender_type === 'customer') break;
    if (counts(m)) run++;
  }
  return run;
}

/**
 * Whether the next message would start a chat: nothing in the thread
 * for 24 hours, and the customer was not the last to write (answering
 * them is a reply, however late). Mirrors team_activity_starts().
 */
export function wouldStartChat(
  messages: readonly ThreadMessageLike[],
  now: number
): boolean {
  let latest: ThreadMessageLike | null = null;
  let latestAt = -Infinity;
  for (const m of messages) {
    if (!counts(m)) continue;
    const t = Date.parse(m.created_at);
    if (Number.isFinite(t) && t > latestAt) {
      latestAt = t;
      latest = m;
    }
  }
  if (!latest) return true;
  if (latest.sender_type === 'customer') return false;
  return latestAt <= now - DAY_MS;
}

/**
 * The day-limit warnings for a message that would start a chat on a
 * Whapi number: the person's own limit, then the number's. Empty for a
 * reply, or a Meta number.
 */
export function limitNotices(args: {
  starting: boolean;
  day: MyOutreachDay | null;
  channelId: string | null;
  provider: 'whapi' | 'meta' | null;
  /** The sending number's whatsapp_config.created_at, for warm-up. */
  numberCreatedAt?: string | null;
  /** Needed with numberCreatedAt (ms). */
  now?: number;
}): OutreachNotice[] {
  const { starting, day, channelId, provider, numberCreatedAt, now } = args;
  if (provider !== 'whapi' || !starting || !day) return [];

  const notices: OutreachNotice[] = [];
  const limit = day.limits.dailyNewChatsPerUser;
  if (day.started >= limit) {
    notices.push({
      kind: 'limit_reached',
      severity: 'critical',
      started: day.started,
      limit,
      blocked: day.blockedWhenOver,
    });
  } else if (day.started >= Math.ceil(limit * NEAR_SHARE)) {
    notices.push({
      kind: 'limit_near',
      severity: 'warning',
      started: day.started,
      limit,
    });
  }

  const onNumber = channelId
    ? day.numbers.find((n) => n.channelId === channelId)
    : undefined;
  const perNumber = day.limits.dailyNewChatsPerNumber;
  // The SQL's flag (073) first; else the number's age, when known.
  const warmingUp =
    typeof onNumber?.warmingUp === 'boolean'
      ? onNumber.warmingUp
      : onNumber?.effectiveLimit != null
        ? onNumber.effectiveLimit < perNumber
        : now !== undefined && isWarmingUp(numberCreatedAt, now);
  const numberLimit =
    onNumber?.effectiveLimit ?? effectiveNumberLimit(perNumber, warmingUp);
  if (onNumber && onNumber.started >= numberLimit) {
    notices.push({
      kind: 'number_limit',
      severity: 'critical',
      started: onNumber.started,
      limit: numberLimit,
      blocked: day.blockedWhenOver,
      warmingUp,
    });
  }
  return notices;
}

/** The warnings to show above the composer, loudest first. */
export function outreachNotices(args: {
  messages: readonly ThreadMessageLike[];
  day: MyOutreachDay | null;
  /** The number the reply will go out on. */
  channelId: string | null;
  provider: 'whapi' | 'meta' | null;
  /** The sending number's created_at, for the warm-up limit (D6). */
  numberCreatedAt?: string | null;
  now: number;
}): OutreachNotice[] {
  const { messages, day, channelId, provider, numberCreatedAt, now } = args;
  if (provider !== 'whapi') return [];

  const starting = wouldStartChat(messages, now);
  const notices = limitNotices({
    starting,
    day,
    channelId,
    provider,
    numberCreatedAt,
    now,
  });

  const max = day?.limits.maxUnansweredInRow ?? 3;
  const run = unansweredRun(messages);
  if (run >= max) {
    notices.push({ kind: 'unanswered', severity: 'warning', count: run, max });
  }

  if (
    starting &&
    notices.length === 0 &&
    !messages.some((m) => m.sender_type === 'customer')
  ) {
    notices.push({ kind: 'new_contact_tip', severity: 'info' });
  }

  return notices;
}
