import { effectiveNumberLimit } from '@/lib/team-activity/limits';
import type { MyOutreachDay } from '@/lib/team-activity/thread-guard';
import { isLinkedDeviceNumber } from '@/lib/whatsapp/channel-management';

// ------------------------------------------------------------
// The home "New chats today" card: the person's own count against
// their daily limit, then each phone number's against its own. Pure.
// ------------------------------------------------------------

export type OutreachTone = 'success' | 'warning' | 'destructive';

export interface OutreachBar {
  /** 'me' for the person's own bar, else the number's config row id. */
  key: string;
  /** The number's label or phone; null for the person's own bar. */
  name: string | null;
  started: number;
  /** Null when no limit applies (a limit of 0 or less). */
  limit: number | null;
  /** started / limit as 0..100, clamped; 0 with no limit. */
  percent: number;
  tone: OutreachTone;
  /** A young number held to the warm-up limit today. */
  warmingUp: boolean;
}

/** The subset of an account number the card reads. */
export interface OutreachNumber {
  id: string;
  provider: string;
  label: string | null;
  /** Whapi and OpenWA: the connected phone. */
  waba_id: string | null;
}

/** Success under 80%, warning from 80%, destructive at the limit. */
export function outreachTone(
  started: number,
  limit: number | null
): OutreachTone {
  if (limit === null || limit <= 0) return 'success';
  const ratio = started / limit;
  if (ratio >= 1) return 'destructive';
  if (ratio >= 0.8) return 'warning';
  return 'success';
}

function bar(
  key: string,
  name: string | null,
  started: number,
  rawLimit: number | null | undefined,
  warmingUp: boolean
): OutreachBar {
  const limit =
    rawLimit !== null && rawLimit !== undefined && rawLimit > 0
      ? rawLimit
      : null;
  const percent =
    limit === null ? 0 : Math.min(100, Math.max(0, (started / limit) * 100));
  return {
    key,
    name,
    started,
    limit,
    percent,
    tone: outreachTone(started, limit),
    warmingUp,
  };
}

/**
 * The person's bar first, then one per phone number (Whapi or OpenWA;
 * the Cloud API has no new-chat limit) in the account's number order.
 * A number's limit is the one the SQL computed for today when it sent
 * one, else the account's per-number limit, held to the warm-up limit
 * when the SQL says the number is warming up. A phone number that
 * started nothing today still gets a bar at 0.
 */
export function outreachBars(
  day: MyOutreachDay,
  numbers: readonly OutreachNumber[]
): { me: OutreachBar; numbers: OutreachBar[] } {
  const byChannel = new Map(day.numbers.map((n) => [n.channelId, n]));
  const perNumber = numbers
    .filter((n) => isLinkedDeviceNumber(n.provider))
    .map((n) => {
      const row = byChannel.get(n.id);
      const warmingUp = row?.warmingUp === true;
      const limit =
        row?.effectiveLimit ??
        effectiveNumberLimit(day.limits.dailyNewChatsPerNumber, warmingUp);
      return bar(
        n.id,
        n.label?.trim() || n.waba_id || null,
        row?.started ?? 0,
        limit,
        warmingUp
      );
    });
  return {
    me: bar('me', null, day.started, day.limits.dailyNewChatsPerUser, false),
    numbers: perNumber,
  };
}
