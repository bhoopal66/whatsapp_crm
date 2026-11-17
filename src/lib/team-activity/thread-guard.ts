// ============================================================
// The composer's outreach warnings: what an employee should know
// before the next message goes out on a phone number (a linked device:
// Whapi or OpenWA, migration 145).
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
// restriction risk this guards against is the unofficial (linked
// device) one,
// and a Meta number cannot start a chat without an approved template.
//
// "At the limit" is >= everywhere (D5), and a phone number younger
// than WARM_UP_DAYS has the tighter warm-up limit (D6). The number's
// age comes from team_activity_my_day's effective_daily_limit when the
// SQL sends it, else from the number's created_at, which the caller
// passes in (`numberCreatedAt`; useAccountNumbers must select it).
// ============================================================

import { isLinkedDeviceNumber } from '@/lib/whatsapp/channel-management';

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
  /**
   * The hard restrictions (migrations 204-205), when the server sends
   * them. Absent from an older server: every notice is then worded as
   * before.
   */
  restrictions?: OutreachRestrictions;
}

export const RESTRICTION_RULE_KEYS = [
  'daily_user',
  'daily_number',
  'burst',
  'quiet_hours',
  'chase',
  'links_first',
  'same_opener',
  'reply_rate',
  'jev',
] as const;

export type RestrictionRuleKey = (typeof RESTRICTION_RULE_KEYS)[number];

export interface OutreachRestrictions {
  on: boolean;
  ownerExempt: boolean;
  rules: Record<RestrictionRuleKey, boolean>;
  /** Hours as the server sent them (an hour number or "HH:MM"). */
  quietHours: { start: string; end: string; tz: string } | null;
  /** Today's per-person limit after the reply-rate throttle. */
  effectiveUserLimit: number | null;
  throttled: boolean;
  maxUnansweredInRow: number | null;
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
      /** The limit was cut by the reply-rate throttle. */
      throttled?: boolean;
    }
  | {
      kind: 'limit_near';
      severity: 'warning';
      started: number;
      limit: number;
      throttled?: boolean;
    }
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
  | {
      kind: 'unanswered';
      severity: 'warning' | 'critical';
      count: number;
      max: number;
      /** The chase rule refuses the next message. */
      blocked?: boolean;
    }
  | { kind: 'quiet_hours'; severity: 'critical'; end: string }
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
  const restrictions = parseRestrictions(o.restrictions);
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
    ...(restrictions ? { restrictions } : {}),
  };
}

const finiteOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

function hourText(v: unknown): string | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 24) {
    return String(v);
  }
  return typeof v === 'string' && /^\d{1,2}(:\d{2})?/.test(v) ? v : null;
}

function parseRestrictions(raw: unknown): OutreachRestrictions | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const rulesRaw =
    o.rules && typeof o.rules === 'object'
      ? (o.rules as Record<string, unknown>)
      : {};
  const rules = Object.fromEntries(
    RESTRICTION_RULE_KEYS.map((k) => [k, rulesRaw[k] === true])
  ) as Record<RestrictionRuleKey, boolean>;
  const q =
    o.quiet_hours && typeof o.quiet_hours === 'object'
      ? (o.quiet_hours as Record<string, unknown>)
      : null;
  const start = hourText(q?.start);
  const end = hourText(q?.end);
  return {
    on: o.on === true,
    ownerExempt: o.owner_exempt === true,
    rules,
    quietHours:
      start && end && typeof q?.tz === 'string' && q.tz
        ? { start, end, tz: q.tz }
        : null,
    effectiveUserLimit: finiteOrNull(o.effective_user_limit),
    throttled: o.throttled === true,
    maxUnansweredInRow: finiteOrNull(o.max_unanswered_in_row),
  };
}

/** Whether a rule refuses this person's sends (restrictions on, not exempt). */
function ruleEnforced(
  r: OutreachRestrictions | undefined,
  rule: RestrictionRuleKey
): boolean {
  return !!r && r.on && !r.ownerExempt && r.rules[rule];
}

/** Minutes past midnight of an "H", "HH" or "HH:MM" hour; null if not one. */
function minutesOf(v: string): number | null {
  const m = /^(\d{1,2})(?::(\d{2}))?/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? '0');
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/**
 * The quiet hours' end ("HH:MM") when `now` falls inside them in their
 * time zone, else null. A window may wrap past midnight (21:00-08:00);
 * start == end is no window. An unknown time zone is no window.
 */
export function quietHoursEnd(
  q: { start: string; end: string; tz: string },
  now: number
): string | null {
  const start = minutesOf(q.start);
  const end = minutesOf(q.end);
  if (start === null || end === null || start === end) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: q.tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(now));
  } catch {
    return null;
  }
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const t = hour * 60 + minute;
  const inside = start < end ? t >= start && t < end : t >= start || t < end;
  if (!inside) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(end / 60))}:${pad(end % 60)}`;
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
 * phone (Whapi or OpenWA) number: the person's own limit, then the
 * number's. Empty for a
 * reply, or a Meta number.
 */
export function limitNotices(args: {
  starting: boolean;
  day: MyOutreachDay | null;
  channelId: string | null;
  provider: 'whapi' | 'meta' | 'openwa' | null;
  /** The sending number's whatsapp_config.created_at, for warm-up. */
  numberCreatedAt?: string | null;
  /** Needed with numberCreatedAt (ms). */
  now?: number;
}): OutreachNotice[] {
  const { starting, day, channelId, provider, numberCreatedAt, now } = args;
  if (!provider || !isLinkedDeviceNumber(provider) || !starting || !day) {
    return [];
  }

  const notices: OutreachNotice[] = [];
  const r = day.restrictions;

  // Quiet hours refuse every new chat, whatever the counts.
  if (ruleEnforced(r, 'quiet_hours') && r?.quietHours && now !== undefined) {
    const end = quietHoursEnd(r.quietHours, now);
    if (end) notices.push({ kind: 'quiet_hours', severity: 'critical', end });
  }

  // With restrictions sent, the rule decides whether a send past the
  // limit is refused, and a throttled person's limit is the cut one.
  const userEnforced = ruleEnforced(r, 'daily_user');
  const throttled =
    userEnforced && r!.throttled && r!.effectiveUserLimit !== null;
  const limit = throttled
    ? r!.effectiveUserLimit!
    : day.limits.dailyNewChatsPerUser;
  const userBlocked = r ? userEnforced : day.blockedWhenOver;
  const throttleField = r ? { throttled } : {};
  if (day.started >= limit) {
    notices.push({
      kind: 'limit_reached',
      severity: 'critical',
      started: day.started,
      limit,
      blocked: userBlocked,
      ...throttleField,
    });
  } else if (day.started >= Math.ceil(limit * NEAR_SHARE)) {
    notices.push({
      kind: 'limit_near',
      severity: 'warning',
      started: day.started,
      limit,
      ...throttleField,
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
      blocked: r ? ruleEnforced(r, 'daily_number') : day.blockedWhenOver,
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
  provider: 'whapi' | 'meta' | 'openwa' | null;
  /** The sending number's created_at, for the warm-up limit (D6). */
  numberCreatedAt?: string | null;
  now: number;
}): OutreachNotice[] {
  const { messages, day, channelId, provider, numberCreatedAt, now } = args;
  if (!provider || !isLinkedDeviceNumber(provider)) return [];

  const starting = wouldStartChat(messages, now);
  const notices = limitNotices({
    starting,
    day,
    channelId,
    provider,
    numberCreatedAt,
    now,
  });

  // With the chase rule enforced, the run at its limit means the next
  // message is refused, not merely unwise.
  const chase = ruleEnforced(day?.restrictions, 'chase');
  const max =
    (chase ? day?.restrictions?.maxUnansweredInRow : null) ??
    day?.limits.maxUnansweredInRow ??
    3;
  const run = unansweredRun(messages);
  if (run >= max) {
    notices.push(
      chase
        ? {
            kind: 'unanswered',
            severity: 'critical',
            count: run,
            max,
            blocked: true,
          }
        : { kind: 'unanswered', severity: 'warning', count: run, max }
    );
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
