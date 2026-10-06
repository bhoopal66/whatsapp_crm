// ============================================================
// Team activity limits (migration 068): the thresholds behind the
// Team activity page, the composer warnings, the bell alerts and the
// optional block on new chats.
//
// Pure and dependency-free, because the browser imports it.
//
// The defaults live in four places: the column defaults and
// `team_activity_limits()` in 068, TEAM_ACTIVITY_DEFAULTS here, and
// docs/team-activity.md. limits.test.ts keeps the first three equal,
// and LIMIT_BOUNDS equal to the table's CHECK constraints.
// ============================================================

export interface TeamActivityLimits {
  /** New chats one person may start in a local day. */
  dailyNewChatsPerUser: number;
  /** New chats one Whapi number may start in a local day, everyone together. */
  dailyNewChatsPerNumber: number;
  /** Percent of started chats that should get a reply. */
  minReplyRate: number;
  /** Messages in a row a contact may receive without answering. */
  maxUnansweredInRow: number;
  /** New chats one person may start inside any 10 minutes. */
  burstNewChats10min: number;
  /** Local hour (0-23) night starts begin. Equal to the end: off. */
  quietHoursStart: number;
  /** Local hour (0-23) night starts end. */
  quietHoursEnd: number;
  /** IANA zone that defines "today". Null until an admin saves. */
  timezone: string | null;
  /** Bell alerts to owners, admins and the person over the limit. */
  notify: boolean;
  /** Refuse a person's new chat once they, or the number, are at the limit. */
  blockOverLimit: boolean;
}

export const TEAM_ACTIVITY_DEFAULTS: Readonly<TeamActivityLimits> = {
  dailyNewChatsPerUser: 20,
  dailyNewChatsPerNumber: 50,
  minReplyRate: 30,
  maxUnansweredInRow: 3,
  burstNewChats10min: 10,
  quietHoursStart: 22,
  quietHoursEnd: 8,
  timezone: null,
  notify: true,
  blockOverLimit: false,
};

type NumericLimit = Exclude<
  keyof TeamActivityLimits,
  'timezone' | 'notify' | 'blockOverLimit'
>;

/** Inclusive bounds; the table's CHECK constraints say the same. */
export const LIMIT_BOUNDS: Readonly<Record<NumericLimit, [number, number]>> = {
  dailyNewChatsPerUser: [1, 1000],
  dailyNewChatsPerNumber: [1, 5000],
  minReplyRate: [0, 100],
  maxUnansweredInRow: [1, 50],
  burstNewChats10min: [1, 500],
  quietHoursStart: [0, 23],
  quietHoursEnd: [0, 23],
};

/** The camelCase field ↔ the settings table's column. */
export const LIMIT_COLUMNS: Readonly<Record<keyof TeamActivityLimits, string>> =
  {
    dailyNewChatsPerUser: 'daily_new_chats_per_user',
    dailyNewChatsPerNumber: 'daily_new_chats_per_number',
    minReplyRate: 'min_reply_rate',
    maxUnansweredInRow: 'max_unanswered_in_row',
    burstNewChats10min: 'burst_new_chats_10min',
    quietHoursStart: 'quiet_hours_start',
    quietHoursEnd: 'quiet_hours_end',
    timezone: 'timezone',
    notify: 'notify',
    blockOverLimit: 'block_over_limit',
  };

/**
 * Answered-or-not chats (older than a day, migration 073) a reply rate
 * is judged on, for a person and for a number alike. Below it one
 * unlucky day swings the percentage too far to mean anything.
 */
export const MIN_REPLY_RATE_SAMPLE = 5;

/**
 * Points above min_reply_rate that are still "close to the minimum".
 * The two bands are [0, min) and [min, min + margin), compared on the
 * unrounded rate.
 */
export const REPLY_RATE_MARGIN = 10;

/** Same opener in this many chats on one number counts as identical text. */
export const IDENTICAL_OPENER_MIN_CHATS = 5;

/**
 * Warm-up (migration 073): a phone number connected less than this many
 * days ago starts at most WARM_UP_DAILY_LIMIT new chats a day, or the
 * account's per-number limit when that is lower. The report, the bell
 * sweep and team_activity_start_check say the same in SQL.
 */
export const WARM_UP_DAYS = 14;
export const WARM_UP_DAILY_LIMIT = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a phone number connected at `createdAt` is still warming up
 * at `now` (ms). False when the date is missing or unreadable: an
 * unknown age never tightens a limit.
 */
export function isWarmingUp(
  createdAt: string | null | undefined,
  now: number
): boolean {
  if (!createdAt) return false;
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return false;
  return now - t < WARM_UP_DAYS * DAY_MS;
}

/** Whole days since `createdAt`, or null when it cannot be read. */
export function ageInDays(
  createdAt: string | null | undefined,
  now: number
): number | null {
  if (!createdAt) return null;
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

/** A phone number's daily new-chat limit, tightened while it warms up. */
export function effectiveNumberLimit(
  dailyNewChatsPerNumber: number,
  warmingUp: boolean
): number {
  return warmingUp
    ? Math.min(WARM_UP_DAILY_LIMIT, dailyNewChatsPerNumber)
    : dailyNewChatsPerNumber;
}

function intOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value)
    : fallback;
}

/**
 * Limits from a settings row or the `limits` object the report and
 * `team_activity_my_day` return (both snake_case). Missing or malformed
 * fields take the default, so a partial payload never yields NaN.
 */
export function limitsFromRow(
  row: Record<string, unknown> | null | undefined
): TeamActivityLimits {
  const r = row ?? {};
  const d = TEAM_ACTIVITY_DEFAULTS;
  return {
    dailyNewChatsPerUser: intOr(
      r.daily_new_chats_per_user,
      d.dailyNewChatsPerUser
    ),
    dailyNewChatsPerNumber: intOr(
      r.daily_new_chats_per_number,
      d.dailyNewChatsPerNumber
    ),
    minReplyRate: intOr(r.min_reply_rate, d.minReplyRate),
    maxUnansweredInRow: intOr(r.max_unanswered_in_row, d.maxUnansweredInRow),
    burstNewChats10min: intOr(r.burst_new_chats_10min, d.burstNewChats10min),
    quietHoursStart: intOr(r.quiet_hours_start, d.quietHoursStart),
    quietHoursEnd: intOr(r.quiet_hours_end, d.quietHoursEnd),
    timezone:
      typeof r.timezone === 'string' && r.timezone.trim() ? r.timezone : null,
    notify: typeof r.notify === 'boolean' ? r.notify : d.notify,
    blockOverLimit:
      typeof r.block_over_limit === 'boolean'
        ? r.block_over_limit
        : d.blockOverLimit,
  };
}

/**
 * True when `zone` is a named IANA time zone this runtime knows. Offset
 * strings such as "+04" are refused even though the browser accepts
 * them: Postgres reads them as POSIX zones, with the sign reversed, so
 * "today" would land eight hours out.
 */
export function isValidTimeZone(zone: string): boolean {
  if (!zone || zone.length > 64 || !/^[A-Za-z]/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; error: string };

/**
 * Validate the body of PUT /api/team-activity/settings: every limit,
 * in bounds, plus a real time zone (a saved row always has one, so the
 * whole account shares one "today").
 */
export function parseLimitsInput(
  json: unknown
): ParseResult<TeamActivityLimits & { timezone: string }> {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, error: 'Expected a JSON object.' };
  }
  const body = json as Record<string, unknown>;
  const out: Partial<TeamActivityLimits> = {};

  for (const key of Object.keys(LIMIT_BOUNDS) as NumericLimit[]) {
    const value = body[key];
    const [min, max] = LIMIT_BOUNDS[key];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return { ok: false, error: `${key} must be a whole number.` };
    }
    if (value < min || value > max) {
      return {
        ok: false,
        error: `${key} must be between ${min} and ${max}.`,
      };
    }
    out[key] = value;
  }

  for (const key of ['notify', 'blockOverLimit'] as const) {
    if (typeof body[key] !== 'boolean') {
      return { ok: false, error: `${key} must be true or false.` };
    }
    out[key] = body[key] as boolean;
  }

  const zone = typeof body.timezone === 'string' ? body.timezone.trim() : '';
  if (!isValidTimeZone(zone)) {
    return { ok: false, error: 'timezone must be a valid IANA time zone.' };
  }

  return {
    ok: true,
    value: { ...(out as TeamActivityLimits), timezone: zone },
  };
}

/** The settings row to upsert for these limits. */
export function rowFromLimits(
  accountId: string,
  limits: TeamActivityLimits & { timezone: string }
): Record<string, unknown> {
  const row: Record<string, unknown> = { account_id: accountId };
  for (const key of Object.keys(LIMIT_COLUMNS) as Array<
    keyof TeamActivityLimits
  >) {
    row[LIMIT_COLUMNS[key]] = limits[key];
  }
  return row;
}

/**
 * Whether a local hour falls in the quiet hours. The window is
 * [start, end): 22 → 8 covers 22:00-07:59. Start after end wraps past
 * midnight; start equal to end turns the check off. Mirrors the CASE
 * in team_activity_report().
 */
export function inQuietHours(
  hour: number,
  start: number,
  end: number
): boolean {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}
