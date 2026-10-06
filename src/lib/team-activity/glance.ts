// ============================================================
// The plain-language figures the Team activity page leads with:
// today's new chats, how many people write back ("4 in 10"), and the
// customers waiting now; plus each phone number's limit bar. Pure.
// ============================================================

import { replyRateBand } from './risk';
import {
  exactReplyRate,
  totalsOf,
  type NumberActivity,
  type TeamActivityReport,
} from './report';
import { MIN_REPLY_RATE_SAMPLE } from './limits';

export type Tone = 'good' | 'warn' | 'bad';

export interface ReplyFigure {
  replied: number;
  total: number;
  /** Out of ten, floored, so it never reads better than the threshold. */
  outOfTen: number;
  /** The minimum, out of ten (30% → 3, 35% → 3.5). */
  aimOutOfTen: number;
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
      outOfTen: Math.floor((exactReplyRate(total, matureNoReply) ?? 0) / 10),
      aimOutOfTen: Math.round(min) / 10,
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
