// ============================================================
// Hard restrictions on a person's send (migration 204,
// team_activity_start_check/3): on a company phone (Whapi or OpenWA)
// number a person's message is refused when it would chase a silent
// customer, or START a chat at night, over a daily or burst limit, with
// a link, or with the same opener as too many chats today. The owner is
// exempt; the SQL decides who and what is in scope.
//
// A guard rail, not a reason for a message to fail: every error,
// including a database without migration 204, lets the message
// through. A deliberate block is never swallowed.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isMissingFunction } from './db-errors';

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

export type RestrictionDetail = Record<string, unknown>;

export interface SendAllowed {
  blocked: false;
  /** The send would start a chat (no message for 24 h, customer not last). */
  isStart: boolean;
  /** An approved unlock was spent on this send: every rule, Jev included, is skipped. */
  unlockUsed: boolean;
  /** Ask Jev whether this start is a cold pitch, refusing at P >= minP. */
  jev: { enabled: boolean; minP: number };
}

export interface SendBlocked {
  blocked: true;
  /** An unknown rule from a newer database still blocks. */
  rule: RestrictionRule | string;
  /** The team_activity_blocks row; an unlock request names it. */
  blockId: string | null;
  /** The account lets a blocked person ask for a one-time unlock. */
  unlockable: boolean;
  detail: RestrictionDetail;
  isStart: boolean;
}

export type SendDecision = SendAllowed | SendBlocked;

/** 204's default for jev_block_min_p. */
export const JEV_DEFAULT_MIN_P = 0.85;

const ALLOW: SendAllowed = {
  blocked: false,
  isStart: false,
  unlockUsed: false,
  jev: { enabled: false, minP: JEV_DEFAULT_MIN_P },
};
let missingLogged = false;

function logFailure(error: { code?: string; message?: string } | unknown) {
  if (
    error &&
    typeof error === 'object' &&
    isMissingFunction(error as { code?: string })
  ) {
    if (!missingLogged) {
      missingLogged = true;
      console.warn(
        '[team-activity] team_activity_start_check(uuid, uuid, text) is missing — apply migration 204.'
      );
    }
    return;
  }
  console.error(
    '[team-activity] send check failed:',
    error instanceof Error
      ? error.message
      : ((error as { message?: string })?.message ?? String(error))
  );
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Ask the database whether this person may send this text in this
 * conversation on this number. `db` must be the sender's own client:
 * the check reads `auth.uid()`. Spends an approved unlock when one
 * applies.
 */
export async function checkHumanSend(
  db: SupabaseClient,
  conversationId: string,
  channelId: string | null,
  text: string | null
): Promise<SendDecision> {
  try {
    const { data, error } = await db.rpc('team_activity_start_check', {
      p_conversation: conversationId,
      p_channel_id: channelId,
      p_text: text,
    });
    if (error) {
      logFailure(error);
      return ALLOW;
    }
    const o = asRecord(data);
    const isStart = o.is_start === true;
    if (o.blocked === true) {
      return {
        blocked: true,
        rule: typeof o.rule === 'string' && o.rule ? o.rule : 'unknown',
        blockId:
          typeof o.block_id === 'string' && o.block_id ? o.block_id : null,
        unlockable: o.unlockable === true,
        detail: asRecord(o.detail),
        isStart,
      };
    }
    if (o.blocked !== false) return ALLOW;
    const jev = asRecord(o.jev);
    const minP = Number(jev.min_p);
    return {
      blocked: false,
      isStart,
      unlockUsed: o.unlock_used === true,
      jev: {
        enabled: jev.enabled === true,
        minP:
          Number.isFinite(minP) && minP > 0 && minP <= 1
            ? minP
            : JEV_DEFAULT_MIN_P,
      },
    };
  } catch (err) {
    logFailure(err);
    return ALLOW;
  }
}

/**
 * Record Jev's cold-pitch refusal (team_activity_record_block). Returns
 * the block id, or null when the row could not be written: the send is
 * still refused, it just cannot be unlocked.
 */
export async function recordJevBlock(
  db: SupabaseClient,
  conversationId: string,
  channelId: string | null,
  p: number
): Promise<string | null> {
  try {
    const { data, error } = await db.rpc('team_activity_record_block', {
      p_conversation: conversationId,
      p_channel_id: channelId,
      p_rule: 'jev_cold_pitch',
      p_detail: { p },
    });
    if (error) {
      console.error(
        '[team-activity] recording a Jev block failed:',
        error.message
      );
      return null;
    }
    return typeof data === 'string' && data ? data : null;
  } catch (err) {
    console.error(
      '[team-activity] recording a Jev block failed:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

function num(detail: RestrictionDetail, key: string): number | null {
  const v = detail[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function hour(h: number | null): string {
  return h === null ? '?' : `${String(h).padStart(2, '0')}:00`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What the sender is told. It reaches the composer's error card. */
export function restrictionMessage(
  rule: string,
  detail: RestrictionDetail = {}
): string {
  const started = num(detail, 'started');
  const limit = num(detail, 'limit');
  switch (rule) {
    case 'chase': {
      const n = limit ?? num(detail, 'steps');
      return n === null
        ? "This customer hasn't answered your last messages. Wait for them to reply before you write again."
        : `This customer hasn't answered your last ${plural(n, 'message', 'messages')}, the most allowed in a row. Wait for them to reply before you write again.`;
    }
    case 'quiet_hours': {
      const tz = typeof detail.tz === 'string' && detail.tz ? detail.tz : 'UTC';
      return `New chats can't be started between ${hour(num(detail, 'start'))} and ${hour(num(detail, 'end'))} (${tz}). Try again after ${hour(num(detail, 'end'))}; replies to existing chats still go out.`;
    }
    case 'daily_user':
      return `You have started ${started ?? limit ?? 'the most'} new chats today, your daily limit${limit !== null ? ` of ${limit}` : ''}. Reply to the chats you already have; you can start new ones tomorrow.`;
    case 'daily_user_throttled': {
      const rate = num(detail, 'reply_rate');
      return `${rate !== null ? `Only ${Math.round(rate)}%` : 'Too few'} of the chats you started this week got a reply, so your daily limit is lowered to ${limit ?? 'fewer'} new chats, and you have started ${started ?? limit ?? 'them all'} today. Reply to the chats you already have; you can start new ones tomorrow.`;
    }
    case 'daily_number':
      return `This WhatsApp number has started ${started ?? limit ?? 'the most'} new chats today, its daily limit${limit !== null ? ` of ${limit}` : ''}${detail.warming_up === true ? ' while it is new and warming up' : ''}. New chats on it can start again tomorrow; replies to existing chats still go out.`;
    case 'burst': {
      const wait = num(detail, 'retry_after_s');
      const mins = wait === null ? null : Math.max(1, Math.ceil(wait / 60));
      return `You have started ${started ?? limit ?? 'too many'} new chats in the last 10 minutes${limit !== null ? `, the limit is ${limit}` : ''}. Wait ${mins === null ? 'a few minutes' : plural(mins, 'minute', 'minutes')} before you start another.`;
    }
    case 'link_first':
      return "A message that starts a new chat can't contain a link. Send it without the link, and share the link once the customer replies.";
    case 'same_opener': {
      const count = num(detail, 'count');
      return `You have already sent this same first message in ${count ?? 'several'} new chats today${limit !== null ? ` (limit ${limit})` : ''}. Write this one in your own words.`;
    }
    case 'jev_cold_pitch':
      return "This reads like an unsolicited sales pitch to someone who hasn't written to you. Start with a short, personal message instead.";
    default:
      return "This message was blocked by your team's WhatsApp safety rules.";
  }
}
