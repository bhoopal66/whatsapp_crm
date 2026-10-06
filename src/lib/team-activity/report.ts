// ============================================================
// The Team activity report (team_activity_report, migrations 068 and
// 073), typed and defended. The function returns one jsonb document;
// this turns it into the shapes the page renders, with every count a
// number, so a missing field shows as 0 instead of NaN.
//
// It reads both generations of the document. Every field 073 added
// falls back to its 068 counterpart (or to a neutral value), so the
// page keeps working on a database where 073 is not applied yet:
//   - mature_started / mature_no_reply  <- chats_started / no_reply
//   - waiting_recent                     <- waiting
//   - chase_existing                     <- unanswered_chats
//   - similar_openers                    <- identical_openers
//   - failed_phone / failed_official     <- 0 (068 never split them,
//     and a total that mixes in the official number would raise the
//     very false alarm D10 removes)
//   - numbers[].kind                     <- provider
//   - warming_up / effective_daily_limit <- created_at vs generated_at
//   - unattributed_starts                <- the 068 no-number row,
//     which is dropped from numbers[] either way (D1)
//   - scope                              <- 'account'
//
// Pure: the API route and the page both use it.
// ============================================================

import {
  ageInDays,
  effectiveNumberLimit,
  isWarmingUp,
  limitsFromRow,
  type TeamActivityLimits,
} from './limits';

/**
 * Who sent: a member, the public API / integrations (Compass), or a
 * bot (flows, automations, AI auto-reply). The SQL may call a member
 * 'user' or 'person'; both read as 'person'.
 */
export type SenderKind = 'person' | 'api' | 'bot';

/** Whose activity the report covers (migration 073, D12). */
export type ReportScope = 'account' | 'team';

/** A phone number (Whapi) or an official WhatsApp number (Meta). */
export type NumberKind = 'phone' | 'official';

export interface SenderActivity {
  kind: SenderKind;
  /** The member's auth user id; null for the API and bot rows. */
  userId: string | null;
  name: string | null;
  email: string | null;
  role: string | null;
  avatarUrl: string | null;

  /** Every message sent in the range (people: sent from this CRM). */
  messagesSent: number;
  /** Distinct conversations messaged. */
  conversations: number;
  failed: number;
  /** Delivered or read. */
  delivered: number;
  read: number;
  /** Local days with at least one message sent. */
  activeDays: number;

  chatsStarted: number;
  /** Started with someone who had never written to us. */
  newContacts: number;
  /** Started and still without an answer (includes pending ones). */
  noReply: number;
  /** Started more than a day ago: the reply-rate sample (D3). */
  matureStarted: number;
  /** Of those, never answered. */
  matureNoReply: number;
  /** Started less than a day ago and not answered yet (D3). */
  pendingReply: number;
  newContactsNoReply: number;
  /** First message to a new contact that carried a link. */
  linksFirst: number;
  /** Openers whose exact text also opened 4+ other chats on the number. */
  identicalOpeners: number;
  /** First messages nearly the same as another of this sender's (D8). */
  similarOpeners: number;
  /** Chats started inside the quiet hours. */
  nightStarts: number;

  /** Most chats started in one local day. */
  peakDay: number;
  /** Days over the per-person daily limit (>, the 068 meaning). */
  daysOverLimit: number;
  /** Days that reached it (>=, D5); falls back to daysOverLimit on 068. */
  daysAtLimit: number;
  /** Chats started so far today (always today, whatever the range). */
  todayStarts: number;
  /** Most chats started inside any 10 minutes. */
  burst10min: number;

  /** Messages sent past max_unanswered_in_row without a reply. */
  unansweredOverLimit: number;
  /** Chats where that happened. */
  unansweredChats: number;
  /** Longest unanswered run this sender added to. */
  maxUnansweredRun: number;
  /** Chats with too many unanswered messages, customer never wrote (D7). */
  chaseNew: number;
  /** The same, with a customer who has written before. */
  chaseExisting: number;
  /** Longest unanswered stretch, messages 10 minutes apart counted once. */
  longestChase: number;

  /** Failed sends on phone (Whapi) numbers (D10). */
  failedPhone: number;
  /** Failed sends on the official (Meta) number. */
  failedOfficial: number;

  /**
   * Replies to a waiting customer. 0 for the API and bot rows, which
   * the SQL reports as null (D9): check `kind` before showing it.
   */
  replies: number;
  /** Median minutes from the customer's message to that reply. */
  responseMedianMin: number | null;

  /** Open chats assigned to this person whose last message is the customer's (now). */
  waiting: number;
  waitingOldestMin: number | null;
  /** Of those, the customer wrote less than 24 hours ago (D11). */
  waitingRecent: number;
  /** Customer wrote 1 to 7 days ago; older than that is ignored. */
  waitingOlder: number;

  broadcasts: number;
  broadcastSent: number;
  broadcastFailed: number;
  broadcastReplied: number;
}

export interface NumberActivity {
  /**
   * whatsapp_config id. Messages with no number are not a row (D1):
   * they are counted in the report's `unattributedStarts`.
   */
  channelId: string | null;
  provider: 'whapi' | 'meta' | null;
  /** 'phone' for a Whapi number, 'official' for the Meta one. */
  kind: NumberKind;
  /** Whole days since the number was connected; null when unknown. */
  ageDays: number | null;
  /** A phone number younger than WARM_UP_DAYS (D6). */
  warmingUp: boolean;
  /** The daily new-chat limit that applies today; null for official. */
  effectiveDailyLimit: number | null;
  label: string | null;
  wabaId: string | null;
  phoneNumberId: string | null;
  status: string | null;
  isPrimary: boolean;
  connectedAt: string | null;
  createdAt: string | null;

  messagesSent: number;
  received: number;
  conversations: number;
  failed: number;
  delivered: number;
  read: number;
  unansweredOverLimit: number;

  chatsStarted: number;
  newContacts: number;
  noReply: number;
  linksFirst: number;
  identicalOpeners: number;
  nightStarts: number;
  peakDay: number;
  daysOverLimit: number;
  burst10min: number;
  /**
   * Chats started on it today. In team scope these are the team's
   * own; `numberTodayStarted` is everyone's.
   */
  todayStarts: number;
  /** Chats started on it today by everyone (equals todayStarts in account scope). */
  numberTodayStarted: number;
  /** Days it reached its limit (>=, phone numbers only). */
  daysAtLimit: number;
  matureStarted: number;
  matureNoReply: number;
  pendingReply: number;
}

export interface DailyActivity {
  /** YYYY-MM-DD in the report's zone. */
  day: string;
  started: number;
  noReply: number;
  /** Started less than a day ago, not answered yet (D3); 0 on 068. */
  pendingReply: number;
  newContacts: number;
  sent: number;
  received: number;
}

export interface HourlyActivity {
  hour: number;
  started: number;
  sent: number;
}

export interface TeamActivityReport {
  tz: string;
  /** Today's date in the report's zone. */
  today: string;
  from: string;
  to: string;
  channelId: string | null;
  generatedAt: string;
  limits: TeamActivityLimits;
  /** Whether an admin has saved the limits (else they are defaults). */
  limitsSaved: boolean;
  /** 'team' for a team leader: only their team's people and figures. */
  scope: ReportScope;
  /** The teams a team leader's report covers; empty in account scope. */
  teamNames: string[];
  /** Open chats nobody is assigned to, waiting on us. */
  waitingUnassigned: number;
  /** Customers who wrote last, less than 24 hours ago (D11 headline). */
  waitingRecent: number;
  /** Customers who wrote last, 1 to 7 days ago. */
  waitingOlder: number;
  /** waitingRecent for chats nobody is assigned to. */
  waitingUnassignedRecent: number;
  /** Chats started on a number the report cannot tell (D1). */
  unattributedStarts: number;
  senders: SenderActivity[];
  numbers: NumberActivity[];
  daily: DailyActivity[];
  hourly: HourlyActivity[];
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}

function arr(v: unknown): Obj[] {
  return Array.isArray(v) ? v.map(obj) : [];
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function has(o: Obj, key: string): boolean {
  return o[key] !== undefined && o[key] !== null;
}

/** The 073 field when present, else its 068 counterpart. */
function numOr(o: Obj, key: string, fallbackKey: string): number {
  return num(has(o, key) ? o[key] : o[fallbackKey]);
}

function senderKind(o: Obj): SenderKind {
  const v = o.kind;
  if (v === 'person' || v === 'user') return 'person';
  if (v === 'bot') return 'bot';
  if (typeof v === 'string' && v !== '') return 'api';
  // No kind at all: a member has an id, the API row does not.
  return str(o.user_id) ? 'person' : 'api';
}

function parseSender(o: Obj): SenderActivity {
  const kind = senderKind(o);
  const person = kind === 'person';
  return {
    kind,
    userId: str(o.user_id),
    name: str(o.name),
    email: str(o.email),
    role: str(o.role),
    avatarUrl: str(o.avatar_url),
    messagesSent: num(o.messages_sent),
    conversations: num(o.conversations),
    failed: num(o.failed),
    delivered: num(o.delivered),
    read: num(o.read),
    activeDays: num(o.active_days),
    chatsStarted: num(o.chats_started),
    newContacts: num(o.new_contacts),
    noReply: num(o.no_reply),
    matureStarted: numOr(o, 'mature_started', 'chats_started'),
    matureNoReply: numOr(o, 'mature_no_reply', 'no_reply'),
    pendingReply: num(o.pending_reply),
    newContactsNoReply: num(o.new_contacts_no_reply),
    linksFirst: num(o.links_first),
    identicalOpeners: num(o.identical_openers),
    similarOpeners: numOr(o, 'similar_openers', 'identical_openers'),
    nightStarts: num(o.night_starts),
    peakDay: num(o.peak_day),
    daysOverLimit: num(o.days_over_limit),
    daysAtLimit: numOr(o, 'days_at_limit', 'days_over_limit'),
    todayStarts: num(o.today_starts),
    burst10min: num(o.burst_10min),
    unansweredOverLimit: num(o.unanswered_over_limit),
    unansweredChats: num(o.unanswered_chats),
    maxUnansweredRun: num(o.max_unanswered_run),
    chaseNew: num(o.chase_new),
    chaseExisting: numOr(o, 'chase_existing', 'unanswered_chats'),
    longestChase: numOr(o, 'longest_chase', 'max_unanswered_run'),
    failedPhone: num(o.failed_phone),
    failedOfficial: num(o.failed_official),
    replies: person ? num(o.replies) : 0,
    responseMedianMin: person ? numOrNull(o.response_median_min) : null,
    waiting: num(o.waiting),
    waitingOldestMin: numOrNull(o.waiting_oldest_min),
    waitingRecent: numOr(o, 'waiting_recent', 'waiting'),
    waitingOlder: num(o.waiting_older),
    broadcasts: num(o.broadcasts),
    broadcastSent: num(o.broadcast_sent),
    broadcastFailed: num(o.broadcast_failed),
    broadcastReplied: num(o.broadcast_replied),
  };
}

function parseNumber(
  o: Obj,
  limits: TeamActivityLimits,
  now: number | null
): NumberActivity {
  const provider =
    o.provider === 'whapi' || o.provider === 'meta' ? o.provider : null;
  const kind: NumberKind =
    o.kind === 'official' || o.kind === 'phone'
      ? o.kind
      : provider === 'meta'
        ? 'official'
        : 'phone';
  const createdAt = str(o.created_at);
  const phone = kind === 'phone';
  // 073 says whether the number is warming up; on 068 the age is
  // worked out here from the date it was connected.
  const warmingUp =
    phone &&
    (typeof o.warming_up === 'boolean'
      ? o.warming_up
      : now !== null && isWarmingUp(createdAt, now));
  const effective = numOrNull(o.effective_daily_limit);
  const todayStarts = numOr(o, 'today_started', 'today_starts');
  return {
    channelId: str(o.channel_id),
    provider,
    kind,
    ageDays: has(o, 'age_days')
      ? numOrNull(o.age_days)
      : now === null
        ? null
        : ageInDays(createdAt, now),
    warmingUp,
    effectiveDailyLimit: phone
      ? (effective ??
        effectiveNumberLimit(limits.dailyNewChatsPerNumber, warmingUp))
      : null,
    label: str(o.label),
    wabaId: str(o.waba_id),
    phoneNumberId: str(o.phone_number_id),
    status: str(o.status),
    isPrimary: o.is_primary === true,
    connectedAt: str(o.connected_at),
    createdAt,
    messagesSent: num(o.messages_sent),
    received: num(o.received),
    conversations: num(o.conversations),
    failed: num(o.failed),
    delivered: num(o.delivered),
    read: num(o.read),
    unansweredOverLimit: num(o.unanswered_over_limit),
    chatsStarted: num(o.chats_started),
    newContacts: num(o.new_contacts),
    noReply: num(o.no_reply),
    linksFirst: num(o.links_first),
    identicalOpeners: num(o.identical_openers),
    nightStarts: num(o.night_starts),
    peakDay: num(o.peak_day),
    daysOverLimit: num(o.days_over_limit),
    burst10min: num(o.burst_10min),
    todayStarts,
    numberTodayStarted: has(o, 'number_today_started')
      ? num(o.number_today_started)
      : todayStarts,
    daysAtLimit: phone ? numOr(o, 'days_at_limit', 'days_over_limit') : 0,
    matureStarted: numOr(o, 'mature_started', 'chats_started'),
    matureNoReply: numOr(o, 'mature_no_reply', 'no_reply'),
    pendingReply: num(o.pending_reply),
  };
}

/** The report from the function's raw jsonb. Never throws. */
export function parseTeamActivityReport(raw: unknown): TeamActivityReport {
  const o = obj(raw);
  const limitsRaw = obj(o.limits);
  const limits = limitsFromRow(limitsRaw);
  const generatedAt = str(o.generated_at) ?? '';
  const generatedMs = Date.parse(generatedAt);
  // Warm-up on a 068 document is judged against when the report was
  // made; with no readable date, nothing is warming up.
  const now = Number.isFinite(generatedMs) ? generatedMs : null;

  const rawNumbers = arr(o.numbers);
  // D1: messages with no number are not a number. 068 sent them as a
  // row with a null channel_id; their starts go to unattributedStarts.
  const unknownRows = rawNumbers.filter((n) => !str(n.channel_id));
  const unattributedStarts = has(o, 'unattributed_starts')
    ? num(o.unattributed_starts)
    : unknownRows.reduce((sum, n) => sum + num(n.chats_started), 0);
  const waitingUnassigned = num(o.waiting_unassigned);
  const waitingUnassignedRecent = has(o, 'waiting_unassigned_recent')
    ? num(o.waiting_unassigned_recent)
    : waitingUnassigned;
  const senders = arr(o.senders).map(parseSender);
  // On 068 the headline is the sum the page used to show.
  const sumOf = (pick: (s: SenderActivity) => number) =>
    senders.reduce((sum, s) => sum + pick(s), 0);

  return {
    tz: str(o.tz) ?? 'UTC',
    today: str(o.today) ?? '',
    from: str(o.from) ?? '',
    to: str(o.to) ?? '',
    channelId: str(o.channel_id),
    generatedAt,
    limits,
    limitsSaved: limitsRaw.saved === true,
    scope: o.scope === 'team' ? 'team' : 'account',
    teamNames: Array.isArray(o.team_names)
      ? o.team_names.filter(
          (n): n is string => typeof n === 'string' && n !== ''
        )
      : [],
    waitingUnassigned,
    waitingRecent: has(o, 'waiting_recent')
      ? num(o.waiting_recent)
      : waitingUnassignedRecent + sumOf((s) => s.waitingRecent),
    waitingOlder: has(o, 'waiting_older')
      ? num(o.waiting_older)
      : sumOf((s) => s.waitingOlder),
    waitingUnassignedRecent,
    unattributedStarts,
    senders,
    numbers: rawNumbers
      .filter((n) => str(n.channel_id))
      .map((n) => parseNumber(n, limits, now)),
    daily: arr(o.daily).map((d) => ({
      day: str(d.day) ?? '',
      started: num(d.started),
      noReply: num(d.no_reply),
      pendingReply: num(d.pending_reply),
      newContacts: num(d.new_contacts),
      sent: num(d.sent),
      received: num(d.received),
    })),
    hourly: arr(o.hourly).map((h) => ({
      hour: num(h.hour),
      started: num(h.started),
      sent: num(h.sent),
    })),
  };
}

/** Percent of started chats answered, rounded; null when nothing was started. */
export function replyRate(started: number, noReply: number): number | null {
  const exact = exactReplyRate(started, noReply);
  return exact === null ? null : Math.round(exact);
}

/**
 * Percent of started chats answered, unrounded: the value thresholds
 * are compared on (D4), so 29.6% is below a 30% minimum.
 */
export function exactReplyRate(
  started: number,
  noReply: number
): number | null {
  if (started <= 0) return null;
  return ((started - noReply) / started) * 100;
}

/**
 * A row's reply rate on mature chats only (D3): chats started less
 * than a day ago may still be answered, so they are left out. Rounded.
 */
export function matureReplyRate(row: {
  matureStarted: number;
  matureNoReply: number;
}): number | null {
  return replyRate(row.matureStarted, row.matureNoReply);
}

export interface ActivityTotals {
  messagesSent: number;
  chatsStarted: number;
  newContacts: number;
  noReply: number;
  matureStarted: number;
  matureNoReply: number;
  pendingReply: number;
  failed: number;
  failedPhone: number;
  failedOfficial: number;
  unansweredOverLimit: number;
  waiting: number;
  /** Customers who wrote less than a day ago, assigned or not (D11). */
  waitingRecent: number;
  waitingOlder: number;
  todayStarts: number;
}

/**
 * Totals over every sender row in the report: people, API and bots in
 * account scope; the team's people in team scope (the SQL sends no
 * others). Waiting counts include the unassigned chats.
 */
export function totalsOf(report: TeamActivityReport): ActivityTotals {
  const t: ActivityTotals = {
    messagesSent: 0,
    chatsStarted: 0,
    newContacts: 0,
    noReply: 0,
    matureStarted: 0,
    matureNoReply: 0,
    pendingReply: 0,
    failed: 0,
    failedPhone: 0,
    failedOfficial: 0,
    unansweredOverLimit: 0,
    waiting: report.waitingUnassigned,
    waitingRecent: report.waitingUnassignedRecent,
    waitingOlder: 0,
    todayStarts: 0,
  };
  for (const s of report.senders) {
    t.messagesSent += s.messagesSent;
    t.chatsStarted += s.chatsStarted;
    t.newContacts += s.newContacts;
    t.noReply += s.noReply;
    t.matureStarted += s.matureStarted;
    t.matureNoReply += s.matureNoReply;
    t.pendingReply += s.pendingReply;
    t.failed += s.failed;
    t.failedPhone += s.failedPhone;
    t.failedOfficial += s.failedOfficial;
    t.unansweredOverLimit += s.unansweredOverLimit;
    t.waiting += s.waiting;
    t.waitingRecent += s.waitingRecent;
    t.waitingOlder += s.waitingOlder;
    t.todayStarts += s.todayStarts;
  }
  return t;
}

/**
 * Whether a sender row is worth a line in the table: every member is
 * listed (a silent member is information too), but the API and bot
 * rows only when they did something.
 */
export function isListedSender(s: SenderActivity): boolean {
  if (s.kind === 'person') return true;
  return s.messagesSent > 0 || s.chatsStarted > 0;
}

/** What to call a number: its label, then the number, then its id. */
export function numberDisplayName(n: {
  label: string | null;
  wabaId: string | null;
  phoneNumberId: string | null;
  provider: 'whapi' | 'meta' | null;
}): string | null {
  if (n.label) return n.label;
  // Whapi keeps the connected phone in waba_id; Meta keeps its WABA id
  // there, which is no name for a number.
  if (n.provider === 'whapi' && n.wabaId)
    return `+${n.wabaId.replace(/^\+/, '')}`;
  return n.phoneNumberId;
}
