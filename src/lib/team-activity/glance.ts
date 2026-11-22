// ============================================================
// The plain-language figures the Team activity page leads with:
// today's new chats, how many people write back ("40% (4 of 10)"), and the
// customers waiting now; plus each phone number's limit bar. Pure.
// ============================================================

import { replyRateBand } from './risk';
import {
  totalsOf,
  type NumberActivity,
  type TeamActivityReport,
} from './report';
import { MIN_REPLY_RATE_SAMPLE } from './limits';

export type Tone = 'good' | 'warn' | 'bad';

export interface ReplyFigure {
  replied: number;
  total: number;
  /** Percent, floored, so it never reads better than the threshold. */
  percent: number;
  /** The minimum, in percent (rounded). */
  aimPercent: number;
  tone: Tone;
}

export interface Glance {
  todayNew: number;
  /** Reply figure on mature chats; null below the minimum sample. */
  reply: ReplyFigure | null;
  /** Chats less than a day old with no answer yet (left out of `reply`). */
  pending: number;
  waitingRecent: number;
  waitingUnassignedRecent: number;
}

/**
 * "100% (8 of 8)": the share of people who wrote back, floored so it
 * never reads better than it is; null for 0 of 0 (shown as a dash).
 */
export function replyPercent(replied: number, total: number): number | null {
  if (!(total > 0)) return null;
  // Integer arithmetic: (29 / 100) * 100 is 28.999… in floating point.
  return Math.floor((Math.max(0, Math.min(replied, total)) * 100) / total);
}

export function glanceOf(report: TeamActivityReport): Glance {
  const totals = totalsOf(report);
  const { matureStarted: total, matureNoReply } = totals;
  const min = report.limits.minReplyRate;
  let reply: ReplyFigure | null = null;
  if (total >= MIN_REPLY_RATE_SAMPLE) {
    const band = replyRateBand(total, matureNoReply, min);
    reply = {
      replied: total - matureNoReply,
      total,
      percent: replyPercent(total - matureNoReply, total) ?? 0,
      aimPercent: Math.round(min),
      tone: band === 'low' ? 'bad' : band === 'close' ? 'warn' : 'good',
    };
  }
  return {
    todayNew: totals.todayStarts,
    reply,
    pending: totals.pendingReply,
    waitingRecent: report.waitingRecent,
    waitingUnassignedRecent: report.waitingUnassignedRecent,
  };
}

export interface NumberBar {
  /** Everyone's new chats on the number today. */
  count: number;
  limit: number;
  /** 0–100, for the bar's width. */
  percent: number;
  tone: Tone;
  /** In team scope, the team's own share of `count`; else null. */
  team: number | null;
}

/** The "new chats today: x of limit" bar; null for an official number. */
export function numberBar(
  n: NumberActivity,
  scope: TeamActivityReport['scope'],
  fallbackLimit: number
): NumberBar | null {
  if (n.kind !== 'phone') return null;
  const limit = Math.max(1, n.effectiveDailyLimit ?? fallbackLimit);
  const count = n.numberTodayStarted;
  const ratio = count / limit;
  return {
    count,
    limit,
    percent: Math.min(100, Math.round(ratio * 100)),
    tone: ratio >= 1 ? 'bad' : ratio >= 0.8 ? 'warn' : 'good',
    team: scope === 'team' ? n.todayStarts : null,
  };
}
