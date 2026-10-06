// ============================================================
// Team activity risk rules: what in a person's or a number's figures
// is worth a warning, how loud, and who should act on it.
//
// The rules follow Whapi's anti-ban guidance (docs/team-activity.md):
// WhatsApp restricts a phone number on what recipients do with its
// messages, so the loudest signals are unanswered chats, pushing past
// the daily limits, bursts of new chats, and messages piled on people
// who do not answer. Pure, so the page and the tests share it.
//
// A Finding:
//   id        stable key, `${subjectKey}:${code}` (React key, dedup)
//   code      what was found (FindingCode)
//   subject   { type: 'person', userId, senderKind }
//             | { type: 'number', channelId } | { type: 'account' }
//   level     'act_now' | 'keep_an_eye'
//   audience  'leader' (a team leader can act on it) | 'owner' (only
//             an owner/admin can: API and bot senders, the Safety
//             Meter). Team scope never shows owner findings (D9, D12).
//   titleKey  `${code}.title`, a short headline
//   bodyKey   `${code}.body`, the sentence with what to do
//   values    numeric ICU arguments; labels the string ones (name,
//             clock times, which automatic sender)
// Render with the TeamActivity.findings namespace:
//   t(f.bodyKey, findingArgs(f))
// `severity` is the 068 name for `level`, kept for the old page.
// ============================================================

import {
  MIN_REPLY_RATE_SAMPLE,
  REPLY_RATE_MARGIN,
  type TeamActivityLimits,
} from './limits';
import {
  exactReplyRate,
  type NumberActivity,
  type SenderActivity,
  type TeamActivityReport,
} from './report';

export type FindingLevel = 'act_now' | 'keep_an_eye';
export type FindingAudience = 'leader' | 'owner';
/** A person's (or number's) overall state. */
export type PersonStatus = 'fine' | 'watch' | 'act';

/** @deprecated 068 names; use FindingLevel / PersonStatus. */
export type Severity = 'critical' | 'warning';
/** @deprecated use PersonStatus. */
export type RiskLevel = 'ok' | 'watch' | 'at_risk';

export type FindingCode =
  // a person (team leader acts)
  | 'reply_rate_low'
  | 'reply_rate_close'
  | 'over_limit_today'
  | 'over_limit_days'
  | 'burst'
  | 'chase_new'
  | 'chase_existing'
  | 'links_first'
  | 'similar_openers'
  | 'night_starts'
  | 'failed_sends'
  | 'waiting'
  // a phone number
  | 'number_at_limit'
  | 'number_near_limit'
  | 'number_over_limit_days'
  | 'number_warming_up'
  | 'number_disconnected'
  | 'number_reply_rate_low'
  | 'number_reply_rate_close'
  | 'number_safety_low'
  // the account
  | 'waiting_unassigned'
  // API and bot senders (owner only)
  | 'auto_review'
  | 'auto_low_reply'
  | 'auto_links_first'
  | 'auto_chasing';

export type FindingSubject =
  | {
      type: 'person';
      userId: string | null;
      senderKind: SenderActivity['kind'];
    }
  | { type: 'number'; channelId: string }
  | { type: 'account' };

export interface Finding {
  id: string;
  code: FindingCode;
  subject: FindingSubject;
  level: FindingLevel;
  audience: FindingAudience;
  titleKey: string;
  bodyKey: string;
  values: Record<string, number>;
  labels: Record<string, string>;
  /** @deprecated use `level`. */
  severity: Severity;
}

/** The ICU arguments for a finding's title and body. */
export function findingArgs(f: Finding): Record<string, string | number> {
  return { ...f.values, ...f.labels };
}

// ---- thresholds ---------------------------------------------------

/** Chats chased with no answer from people who never wrote: critical (D7). */
const CHASE_NEW_CRITICAL = 3;
/** Share of a person's chats that were chased: critical (D7). */
const CHASE_SHARE_CRITICAL = 0.25;
/** Links in a new contact's first message: this many is a warning. */
const LINKS_FIRST_WARNING = 3;
/** Nearly identical first messages: this many is a warning (D8). */
const SIMILAR_OPENERS_WARNING = 3;
/** Chats started in the quiet hours: this many is a warning. */
const NIGHT_STARTS_WARNING = 3;
/** Failed phone sends: at least this many, and FAILED_RATE of the sent. */
const FAILED_MIN = 3;
const FAILED_RATE = 0.05;
/** Customers waiting less than a day on one person: a warning (D11). */
const WAITING_WARNING = 5;
/** Customers waiting on nobody: a warning. */
const WAITING_UNASSIGNED_WARNING = 3;
/** A number this far into its daily limit is a warning. */
const NUMBER_NEAR_SHARE = 0.8;

/**
 * Most urgent first, within a level. Today's limits and a dead number
 * come before habits, because they need doing now.
 */
const CODE_ORDER: readonly FindingCode[] = [
  'number_disconnected',
  'over_limit_today',
  'number_at_limit',
  'reply_rate_low',
  'number_reply_rate_low',
  'chase_new',
  'number_safety_low',
  'auto_review',
  'auto_low_reply',
  'auto_chasing',
  'burst',
  'chase_existing',
  'links_first',
  'auto_links_first',
  'similar_openers',
  'failed_sends',
  'waiting',
  'waiting_unassigned',
  'number_near_limit',
  'reply_rate_close',
  'number_reply_rate_close',
  'night_starts',
  'over_limit_days',
  'number_over_limit_days',
  'number_warming_up',
];

// ---- building ------------------------------------------------------

function subjectKey(s: FindingSubject): string {
  if (s.type === 'person') return `person:${s.senderKind}:${s.userId ?? '-'}`;
  if (s.type === 'number') return `number:${s.channelId}`;
  return 'account';
}

function make(
  subject: FindingSubject,
  code: FindingCode,
  level: FindingLevel,
  audience: FindingAudience,
  values: Record<string, number> = {},
  labels: Record<string, string> = {}
): Finding {
  return {
    id: `${subjectKey(subject)}:${code}`,
    code,
    subject,
    level,
    audience,
    titleKey: `${code}.title`,
    bodyKey: `${code}.body`,
    values,
    labels,
    severity: level === 'act_now' ? 'critical' : 'warning',
  };
}

/**
 * The reply-rate band (D3, D4): judged on mature chats only, with at
 * least MIN_REPLY_RATE_SAMPLE of them, on the unrounded rate. Below
 * the minimum is 'low'; from it to REPLY_RATE_MARGIN points above is
 * 'close'.
 */
export function replyRateBand(
  matureStarted: number,
  matureNoReply: number,
  minReplyRate: number
): 'low' | 'close' | null {
  if (matureStarted < MIN_REPLY_RATE_SAMPLE) return null;
  const rate = exactReplyRate(matureStarted, matureNoReply);
  if (rate === null) return null;
  if (rate < minReplyRate) return 'low';
  if (rate < minReplyRate + REPLY_RATE_MARGIN) return 'close';
  return null;
}

/** Display figure for a rate in the "close" band: floored, never above. */
function closeRate(started: number, noReply: number): number {
  return Math.floor(exactReplyRate(started, noReply) ?? 0);
}

export interface FindingContext {
  limits: TeamActivityLimits;
}

/**
 * Everything worth flagging about one sender row, most urgent first.
 * Members get person findings (audience 'leader'); the API and bot
 * rows only owner findings (D9).
 */
export function senderFindings(
  s: SenderActivity,
  ctxOrLimits: FindingContext | TeamActivityLimits
): Finding[] {
  const limits = 'limits' in ctxOrLimits ? ctxOrLimits.limits : ctxOrLimits;
  const subject: FindingSubject = {
    type: 'person',
    userId: s.userId,
    senderKind: s.kind,
  };
  return sortFindings(
    s.kind === 'person'
      ? personFindings(s, subject, limits)
      : automaticFindings(s, subject, limits)
  );
}

function personFindings(
  s: SenderActivity,
  subject: FindingSubject,
  limits: TeamActivityLimits
): Finding[] {
  const out: Finding[] = [];
  const name = { name: s.name ?? s.email ?? '' };
  const add = (
    code: FindingCode,
    level: FindingLevel,
    values: Record<string, number> = {},
    labels: Record<string, string> = name
  ) => out.push(make(subject, code, level, 'leader', values, labels));

  const band = replyRateBand(
    s.matureStarted,
    s.matureNoReply,
    limits.minReplyRate
  );
  if (band === 'low') {
    add('reply_rate_low', 'act_now', {
      replied: s.matureStarted - s.matureNoReply,
      total: s.matureStarted,
      min: limits.minReplyRate,
    });
  } else if (band === 'close') {
    add('reply_rate_close', 'keep_an_eye', {
      rate: closeRate(s.matureStarted, s.matureNoReply),
      min: limits.minReplyRate,
    });
  }

  // D5: at the limit is enough; no more new chats today.
  if (s.todayStarts >= limits.dailyNewChatsPerUser) {
    add('over_limit_today', 'act_now', {
      count: s.todayStarts,
      limit: limits.dailyNewChatsPerUser,
    });
  }
  if (s.daysAtLimit > 0) {
    add('over_limit_days', 'keep_an_eye', {
      days: s.daysAtLimit,
      limit: limits.dailyNewChatsPerUser,
    });
  }
  if (s.burst10min >= limits.burstNewChats10min) {
    add('burst', 'keep_an_eye', {
      count: s.burst10min,
      limit: limits.burstNewChats10min,
    });
  }

  // D7: one severity for chasing, from the new-people count or the
  // share of the person's chats that were chased.
  const chased = s.chaseNew + s.chaseExisting;
  const share = s.conversations > 0 ? chased / s.conversations : 0;
  const chaseShareCritical = chased > 0 && share >= CHASE_SHARE_CRITICAL;
  if (s.chaseNew > 0) {
    add(
      'chase_new',
      s.chaseNew >= CHASE_NEW_CRITICAL || chaseShareCritical
        ? 'act_now'
        : 'keep_an_eye',
      { count: s.chaseNew, limit: limits.maxUnansweredInRow }
    );
  }
  if (s.chaseExisting > 0) {
    add('chase_existing', chaseShareCritical ? 'act_now' : 'keep_an_eye', {
      count: s.chaseExisting,
      limit: limits.maxUnansweredInRow,
    });
  }

  if (s.linksFirst >= LINKS_FIRST_WARNING) {
    add('links_first', 'keep_an_eye', { count: s.linksFirst });
  }
  if (s.similarOpeners >= SIMILAR_OPENERS_WARNING) {
    add('similar_openers', 'keep_an_eye', { count: s.similarOpeners });
  }
  if (s.nightStarts >= NIGHT_STARTS_WARNING) {
    add(
      'night_starts',
      'keep_an_eye',
      {
        count: s.nightStarts,
        start: limits.quietHoursStart,
        end: limits.quietHoursEnd,
      },
      // "after 22:00 or before 08:00"
      {
        ...name,
        late: clock(limits.quietHoursStart),
        early: clock(limits.quietHoursEnd),
      }
    );
  }
  // D10: only phone-number failures; the official number's failures
  // are the account's (payment, template), not this person's habit.
  if (
    s.failedPhone >= FAILED_MIN &&
    s.messagesSent > 0 &&
    s.failedPhone / s.messagesSent >= FAILED_RATE
  ) {
    add('failed_sends', 'keep_an_eye', { count: s.failedPhone });
  }
  if (s.waitingRecent >= WAITING_WARNING) {
    add('waiting', 'keep_an_eye', { count: s.waitingRecent });
  }
  return out;
}

function automaticFindings(
  s: SenderActivity,
  subject: FindingSubject,
  limits: TeamActivityLimits
): Finding[] {
  const out: Finding[] = [];
  const who = { who: s.kind === 'bot' ? 'bot' : 'api' };
  const low =
    replyRateBand(s.matureStarted, s.matureNoReply, limits.minReplyRate) ===
    'low';
  const rate = Math.round(
    exactReplyRate(s.matureStarted, s.matureNoReply) ?? 0
  );
  const links = s.linksFirst > 0;
  if (low && links) {
    out.push(
      make(
        subject,
        'auto_review',
        'act_now',
        'owner',
        { count: s.matureStarted, rate, links: s.linksFirst },
        who
      )
    );
  } else if (low) {
    out.push(
      make(
        subject,
        'auto_low_reply',
        'act_now',
        'owner',
        { count: s.matureStarted, rate },
        who
      )
    );
  } else if (s.linksFirst >= LINKS_FIRST_WARNING) {
    out.push(
      make(
        subject,
        'auto_links_first',
        'keep_an_eye',
        'owner',
        { count: s.linksFirst },
        who
      )
    );
  }
  const chased = s.chaseNew + s.chaseExisting;
  if (chased > 0) {
    out.push(
      make(
        subject,
        'auto_chasing',
        s.chaseNew >= CHASE_NEW_CRITICAL ? 'act_now' : 'keep_an_eye',
        'owner',
        { count: chased, limit: limits.maxUnansweredInRow },
        who
      )
    );
  }
  return out;
}

/** "08:00" for an hour of the day. */
function clock(hour: number): string {
  return `${String(((hour % 24) + 24) % 24).padStart(2, '0')}:00`;
}

/**
 * Whapi's own Safety Meter for a number (1 = use caution, 2 = needs
 * attention, 3 = good), when it could be read.
 */
export interface SafetyRating {
  riskFactor: number | null;
  lifeTime: number | null;
  riskFactorChats: number | null;
  riskFactorContacts: number | null;
}

/**
 * Everything worth flagging about one number, most urgent first. Only
 * phone (Whapi) numbers are judged (D6): an official number cannot
 * start a chat without an approved template, and Meta rates it itself.
 */
export function numberFindings(
  n: NumberActivity,
  ctxOrLimits: FindingContext | TeamActivityLimits,
  safety?: SafetyRating | null
): Finding[] {
  const limits = 'limits' in ctxOrLimits ? ctxOrLimits.limits : ctxOrLimits;
  const out: Finding[] = [];
  if (!n.channelId || n.kind !== 'phone') return out;
  const subject: FindingSubject = { type: 'number', channelId: n.channelId };
  const add = (
    code: FindingCode,
    level: FindingLevel,
    values: Record<string, number> = {},
    audience: FindingAudience = 'leader'
  ) => out.push(make(subject, code, level, audience, values));

  if (n.status && n.status !== 'connected') {
    add('number_disconnected', 'act_now');
  }

  // D5 + D6: the effective limit (tighter while warming up), reached
  // with >=, counted over everyone who uses the number.
  const limit = n.effectiveDailyLimit ?? limits.dailyNewChatsPerNumber;
  const today = n.numberTodayStarted;
  if (today >= limit) {
    add('number_at_limit', 'act_now', { count: today, limit });
  } else if (today >= Math.ceil(limit * NUMBER_NEAR_SHARE)) {
    add('number_near_limit', 'keep_an_eye', { count: today, limit });
  }
  if (n.daysAtLimit > 0) {
    add('number_over_limit_days', 'keep_an_eye', {
      days: n.daysAtLimit,
      limit,
    });
  }
  if (n.warmingUp) {
    add('number_warming_up', 'keep_an_eye', {
      days: n.ageDays ?? 0,
      limit,
    });
  }

  const band = replyRateBand(
    n.matureStarted,
    n.matureNoReply,
    limits.minReplyRate
  );
  if (band === 'low') {
    add('number_reply_rate_low', 'act_now', {
      replied: n.matureStarted - n.matureNoReply,
      total: n.matureStarted,
      min: limits.minReplyRate,
    });
  } else if (band === 'close') {
    add('number_reply_rate_close', 'keep_an_eye', {
      rate: closeRate(n.matureStarted, n.matureNoReply),
      min: limits.minReplyRate,
    });
  }

  // Team leaders get no Safety Meter (D12): an owner finding.
  const factor = safety?.riskFactor ?? null;
  if (factor === 1 || factor === 2) {
    add(
      'number_safety_low',
      factor === 1 ? 'act_now' : 'keep_an_eye',
      { rating: factor },
      'owner'
    );
  }
  return sortFindings(out);
}

/** Findings about the account as a whole. */
export function accountFindings(report: TeamActivityReport): Finding[] {
  const out: Finding[] = [];
  if (report.waitingUnassignedRecent >= WAITING_UNASSIGNED_WARNING) {
    out.push(
      make({ type: 'account' }, 'waiting_unassigned', 'keep_an_eye', 'leader', {
        count: report.waitingUnassignedRecent,
      })
    );
  }
  return out;
}

// ---- ordering and summaries ---------------------------------------

function levelRank(l: FindingLevel): number {
  return l === 'act_now' ? 2 : 1;
}

function codeRank(c: FindingCode): number {
  const i = CODE_ORDER.indexOf(c);
  return i < 0 ? CODE_ORDER.length : i;
}

/** Most urgent first: act_now before keep_an_eye, then CODE_ORDER. */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    levelRank(b.level) - levelRank(a.level) ||
    codeRank(a.code) - codeRank(b.code)
  );
}

function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort(compareFindings);
}

/** A person's (or number's) overall state from its findings. */
export function statusOf(findings: readonly Finding[]): PersonStatus {
  if (findings.some((f) => f.level === 'act_now')) return 'act';
  if (findings.length > 0) return 'watch';
  return 'fine';
}

export interface Advice {
  /** Key in the TeamActivity.advice namespace. */
  key: string;
  values: Record<string, number>;
}

/**
 * One line of advice for a person: what to do about their most urgent
 * finding, 'fine' when there is none, 'quiet' when they sent nothing.
 */
export function adviceFor(
  s: SenderActivity,
  findings: readonly Finding[]
): Advice {
  const top = [...findings].sort(compareFindings)[0];
  if (top) return { key: top.code, values: top.values };
  if (s.messagesSent === 0 && s.chatsStarted === 0) {
    return { key: 'quiet', values: {} };
  }
  return { key: 'fine', values: {} };
}

export interface PersonAssessment {
  sender: SenderActivity;
  findings: Finding[];
  status: PersonStatus;
  advice: Advice;
}

export interface NumberAssessment {
  number: NumberActivity;
  findings: Finding[];
  status: PersonStatus;
}

export interface ReportAssessment {
  /** Members (kind 'person'), in report order. */
  people: PersonAssessment[];
  numbers: NumberAssessment[];
  /** Account-level findings for a team leader (unassigned waiting). */
  account: Finding[];
  /**
   * The "for the owner" section: API and bot senders, the Safety Meter.
   * Always empty in team scope.
   */
  owner: Finding[];
  /**
   * The most urgent things to do today, at most `todayLimit`: the worst
   * finding of each person or number, so one person with five problems
   * does not fill the list. `todayMore` holds the rest of each one.
   */
  today: Finding[];
  /** The other findings of each `today` subject, keyed by its finding id. */
  todayMore: Record<string, Finding[]>;
}

/**
 * Every finding in a report, grouped for the page. `viewer` is who is
 * looking: a team leader never sees owner findings, nor does anyone in
 * team scope.
 */
export function assessReport(
  report: TeamActivityReport,
  opts: {
    viewer: 'leader' | 'owner';
    safety?: (channelId: string) => SafetyRating | null | undefined;
    todayLimit?: number;
  }
): ReportAssessment {
  const ctx: FindingContext = { limits: report.limits };
  const showOwner = opts.viewer === 'owner' && report.scope === 'account';

  const people: PersonAssessment[] = [];
  const owner: Finding[] = [];
  for (const s of report.senders) {
    const findings = senderFindings(s, ctx);
    if (s.kind === 'person') {
      people.push({
        sender: s,
        findings,
        status: statusOf(findings),
        advice: adviceFor(s, findings),
      });
    } else if (showOwner) {
      owner.push(...findings);
    }
  }

  const numbers: NumberAssessment[] = report.numbers.map((n) => {
    const all = numberFindings(
      n,
      ctx,
      n.channelId ? opts.safety?.(n.channelId) : null
    );
    const leader = all.filter((f) => f.audience === 'leader');
    if (showOwner) owner.push(...all.filter((f) => f.audience === 'owner'));
    const findings = showOwner ? all : leader;
    return { number: n, findings, status: statusOf(findings) };
  });

  const account = accountFindings(report);
  const leaderItems = [
    ...people.flatMap((p) => p.findings),
    ...numbers.flatMap((n) =>
      n.findings.filter((f) => f.audience === 'leader')
    ),
    ...account,
  ];
  // Already sorted most urgent first, so the first finding seen for a
  // subject is its worst one.
  const today: Finding[] = [];
  const todayMore: Record<string, Finding[]> = {};
  const leadOf = new Map<string, Finding>();
  for (const f of [...leaderItems, ...owner].sort(compareFindings)) {
    const key = subjectKey(f.subject);
    const lead = leadOf.get(key);
    if (lead) {
      todayMore[lead.id].push(f);
    } else if (today.length < (opts.todayLimit ?? 5)) {
      leadOf.set(key, f);
      today.push(f);
      todayMore[f.id] = [];
    }
  }

  return {
    people,
    numbers,
    account,
    owner: sortFindings(owner),
    today,
    todayMore,
  };
}

// ---- 068 compatibility (the old page) ------------------------------

/** @deprecated use statusOf. */
export function levelOf(findings: readonly Finding[]): RiskLevel {
  const s = statusOf(findings);
  return s === 'act' ? 'at_risk' : s === 'watch' ? 'watch' : 'ok';
}

/** @deprecated compare PersonStatus instead. */
export function worseLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  const rank = (l: RiskLevel) => (l === 'at_risk' ? 2 : l === 'watch' ? 1 : 0);
  return rank(a) >= rank(b) ? a : b;
}

export interface SubjectFindings<T> {
  subject: T;
  findings: Finding[];
  level: RiskLevel;
}

/** @deprecated use assessReport().today. */
export function flattenFindings<T>(
  subjects: ReadonlyArray<SubjectFindings<T>>
): Array<{ subject: T; finding: Finding }> {
  const rows: Array<{ subject: T; finding: Finding; order: number }> = [];
  subjects.forEach((s, order) => {
    for (const finding of s.findings)
      rows.push({ subject: s.subject, finding, order });
  });
  rows.sort(
    (a, b) =>
      levelRank(b.finding.level) - levelRank(a.finding.level) ||
      a.order - b.order
  );
  return rows.map(({ subject, finding }) => ({ subject, finding }));
}
