// ============================================================
// Reminder suggestions (migration 197): one chat message → at most one
// `message_reminder_suggestions` row, shown as "Add reminder" under the
// message in the inbox.
//
// Display data only, so this never throws and never blocks anything:
// every early exit is an outcome (for tests), and a failure stores
// nothing. Off unless an admin switched it on (ai_insight_settings) on an
// install where Jev is available. Personal chats (migration 191) are
// never judged.
//
// The message text never reaches a log line: failures log the account
// id and the reason only.
// ============================================================

import { supabaseAdmin } from '@/lib/ai/admin-client';
import { getInsightSettings, insightsAvailable } from '@/lib/insights/settings';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getDecisionLayer } from '@/lib/typesafe';
import type { ReminderJudgment } from '@/lib/typesafe/checks/reminder';
import { findTimePhrases } from './time-phrases';
import type { ReminderSide } from './types';

/** Jev's P(yes) a suggestion needs to be stored. */
export const REMINDER_MIN_P = 0.6;

/** A time this close (or past) is not worth a reminder. */
const MIN_LEAD_MS = 2 * 60_000;
/** Longest message judged; matches the judgment's own cap. */
const MAX_TEXT_CHARS = 1000;
const MAX_PHRASE_CHARS = 120;
const TZ_TTL_MS = 5 * 60_000;
const FALLBACK_TZ = 'UTC';

export interface SuggestReminderArgs {
  accountId: string;
  conversationId: string;
  messageId: string;
  text: string;
  side: ReminderSide;
  /** When the message was written, ISO 8601. */
  messageAt: string;
}

export type ReminderSuggestSkip =
  | 'blank'
  | 'too_long'
  | 'unavailable'
  | 'off'
  | 'no_time'
  | 'personal'
  | 'rate_limited'
  | 'jev_failed'
  | 'not_reminder'
  | 'too_soon'
  | 'duplicate'
  | 'error';

export interface ReminderSuggestOutcome {
  skipped: ReminderSuggestSkip | null;
  stored: boolean;
  /** Future time candidates the message named. */
  candidates: number;
  judgment?: ReminderJudgment;
}

const tzCache = new Map<string, { tz: string; at: number }>();

/** Test hook: forget every cached account time zone. */
export function __resetReminderCaches(): void {
  tzCache.clear();
}

function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The account's saved zone (Team activity settings), else UTC, as SQL's
 *  calendar_time_label reads it. Cached per account for 5 minutes; a
 *  failed read is not cached. */
async function accountTimeZone(accountId: string): Promise<string> {
  const hit = tzCache.get(accountId);
  if (hit && Date.now() - hit.at < TZ_TTL_MS) return hit.tz;
  const { data, error } = await supabaseAdmin()
    .from('team_activity_settings')
    .select('timezone')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    console.warn(
      `[reminders] time zone read failed for account ${accountId}: ${error.message}`
    );
    return FALLBACK_TZ;
  }
  const raw = (data as { timezone?: unknown } | null)?.timezone;
  const tz = validTimeZone(raw) ? raw : FALLBACK_TZ;
  tzCache.set(accountId, { tz, at: Date.now() });
  return tz;
}

export async function suggestReminderForMessage(
  args: SuggestReminderArgs
): Promise<ReminderSuggestOutcome> {
  const { accountId, conversationId, messageId, text, side, messageAt } = args;
  const out: ReminderSuggestOutcome = {
    skipped: null,
    stored: false,
    candidates: 0,
  };
  if (!text.trim()) return { ...out, skipped: 'blank' };
  if (text.length > MAX_TEXT_CHARS) return { ...out, skipped: 'too_long' };
  try {
    if (!insightsAvailable(accountId))
      return { ...out, skipped: 'unavailable' };
    const ts = getDecisionLayer();
    if (!ts) return { ...out, skipped: 'unavailable' };
    const settings = await getInsightSettings(accountId);
    if (!settings.reminderSuggestEnabled) return { ...out, skipped: 'off' };

    const timeZone = await accountTimeZone(accountId);
    const earliest = Date.now() + MIN_LEAD_MS;
    const candidates = findTimePhrases(text, {
      now: new Date(messageAt),
      timeZone,
    }).filter((c) => Date.parse(c.at) > earliest);
    out.candidates = candidates.length;
    if (candidates.length === 0) return { ...out, skipped: 'no_time' };

    const db = supabaseAdmin();
    const { data: chat, error: chatError } = await db
      .from('conversations')
      .select('account_id, personal_owner_id')
      .eq('id', conversationId)
      .maybeSingle();
    if (chatError) {
      console.error(
        `[reminders] conversation read failed for account ${accountId}: ${chatError.message}`
      );
      return { ...out, skipped: 'error' };
    }
    const row = chat as {
      account_id: string;
      personal_owner_id: string | null;
    } | null;
    if (!row || row.account_id !== accountId || row.personal_owner_id !== null)
      return { ...out, skipped: 'personal' };

    if (
      !checkRateLimit(
        `reminders:${accountId}`,
        RATE_LIMITS.reminderSuggestAccount
      ).success
    )
      return { ...out, skipped: 'rate_limited' };

    const judgment = await ts.reminder({
      accountId,
      text,
      side,
      times: candidates.map((c) => c.phrase),
    });
    out.judgment = judgment;
    if (!judgment.ok) {
      console.warn(
        `[reminders] Jev judgment failed for account ${accountId}: ${judgment.errorCode}`
      );
      return { ...out, skipped: 'jev_failed' };
    }
    if (!judgment.isReminder || judgment.p < REMINDER_MIN_P)
      return { ...out, skipped: 'not_reminder' };

    const pick = candidates[judgment.timeIndex];
    if (!pick) {
      console.warn(
        `[reminders] Jev time index out of range for account ${accountId}: ${judgment.timeIndex}`
      );
      return { ...out, skipped: 'jev_failed' };
    }
    if (Date.parse(pick.at) <= Date.now() + MIN_LEAD_MS)
      return { ...out, skipped: 'too_soon' };

    const { data: inserted, error: insertError } = await db
      .from('message_reminder_suggestions')
      .upsert(
        {
          account_id: accountId,
          conversation_id: conversationId,
          message_id: messageId,
          side,
          kind: judgment.kind,
          due_at: pick.at,
          date_only: pick.dateOnly,
          phrase: pick.phrase.slice(0, MAX_PHRASE_CHARS),
          p: Math.round(judgment.p * 1000) / 1000,
        },
        { onConflict: 'message_id', ignoreDuplicates: true }
      )
      .select('id');
    if (insertError) {
      console.error(
        `[reminders] suggestion insert failed for account ${accountId}: ${insertError.message}`
      );
      return { ...out, skipped: 'error' };
    }
    if (!inserted || inserted.length === 0)
      return { ...out, skipped: 'duplicate' };
    return { ...out, stored: true };
  } catch (err) {
    console.error(
      `[reminders] suggestion failed for account ${accountId}: ${
        err instanceof Error ? err.message : 'unknown error'
      }`
    );
    return { ...out, skipped: 'error' };
  }
}
