// A time-based trigger's config as the runner reads it (migration 321).
// Pure and client-safe: the builder and activation validation
// (`validate.ts`) refuse exactly what the runner (`time-based.ts`) cannot
// run.

import type { TimeBasedTriggerConfig } from '@/types';

import { isKnownTimeZone, parseCron, type CronSchedule } from './cron';

/** Chats one run acts on at most. */
export const TIME_BASED_MAX_CHATS = 200;

/** The longest `quiet_days` accepted. */
export const QUIET_DAYS_MAX = 365;

export interface TimeBasedConfig {
  schedule: CronSchedule;
  timezone: string | null;
  chatTagId: string;
  chatSubTagId: string | null;
  quietDays: number | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The trigger's config as the runner reads it, or null with the reason
 * it cannot run (a schedule it cannot read, no chat tag, a bad zone).
 * The builder and activation refuse the same things (`validate.ts`).
 */
export function parseTimeBasedConfig(
  raw: unknown
): { ok: true; config: TimeBasedConfig } | { ok: false; reason: string } {
  const cfg = (raw ?? {}) as Partial<TimeBasedTriggerConfig>;
  const schedule = parseCron(
    typeof cfg.schedule === 'string' ? cfg.schedule : ''
  );
  if (!schedule) return { ok: false, reason: 'the schedule cannot be read' };
  const tag = typeof cfg.chat_tag_id === 'string' ? cfg.chat_tag_id.trim() : '';
  if (!UUID.test(tag)) return { ok: false, reason: 'no chat tag is chosen' };
  const sub =
    typeof cfg.chat_sub_tag_id === 'string' && UUID.test(cfg.chat_sub_tag_id)
      ? cfg.chat_sub_tag_id
      : null;
  const tz =
    typeof cfg.timezone === 'string' && cfg.timezone.trim()
      ? cfg.timezone.trim()
      : null;
  if (tz && !isKnownTimeZone(tz)) {
    return { ok: false, reason: 'the time zone is unknown' };
  }
  const q = cfg.quiet_days;
  const quietDays =
    typeof q === 'number' &&
    Number.isInteger(q) &&
    q >= 1 &&
    q <= QUIET_DAYS_MAX
      ? q
      : null;
  return {
    ok: true,
    config: {
      schedule,
      timezone: tz,
      chatTagId: tag,
      chatSubTagId: sub,
      quietDays,
    },
  };
}
