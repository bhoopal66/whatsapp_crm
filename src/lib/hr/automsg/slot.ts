/**
 * {slot}: the interview time a reminder names. Migration 339 queues an
 * `interview_reminder` row with `params.interview_at` (UTC ISO); the
 * time is written in Dubai time, the workspace clock HR works to, in the
 * template's language. Anything else (another trigger, no time, a time
 * that does not parse) keeps SLOT_FALLBACK, and the result is passed
 * through sanitizeParam so it always meets the render rules.
 */
import { SLOT_FALLBACK, sanitizeParam } from './templates';
import type { AutoLang, OutboxRow } from './types';

/** The clock an interview time is written in. */
export const SLOT_TIME_ZONE = 'Asia/Dubai';

const LOCALE: Record<AutoLang, string> = { en: 'en-GB', ar: 'ar-AE' };

/** An interview time in Dubai time, in `lang`; SLOT_FALLBACK when there is none. */
export function formatInterviewSlot(
  interviewAt: string | null | undefined,
  lang: AutoLang
): string {
  if (typeof interviewAt !== 'string' || interviewAt.trim() === '')
    return SLOT_FALLBACK;
  const at = new Date(interviewAt);
  if (Number.isNaN(at.getTime())) return SLOT_FALLBACK;
  const text = new Intl.DateTimeFormat(LOCALE[lang] ?? LOCALE.en, {
    timeZone: SLOT_TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);
  return sanitizeParam(text, SLOT_FALLBACK);
}

/** The {slot} value for an outbox row in the template's language. */
export function slotFor(
  row: Pick<OutboxRow, 'trigger' | 'params'>,
  lang: AutoLang
): string {
  if (row.trigger !== 'interview_reminder') return SLOT_FALLBACK;
  return formatInterviewSlot(row.params?.interview_at, lang);
}
