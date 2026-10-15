// The event dialog's decisions — pure, so they are tested without a DOM.

import { zonedWallTimeToInstant } from '@/lib/meetings/schedule';

import {
  anchorFacts,
  describeRrule,
  formToRrule,
  type RepeatAnchor,
  type RepeatDescription,
} from '../rrule-form';
import { formRrule, type EventFormValues } from './event-form';

/** The zones offered before the account's and the event's own. */
export const COMMON_TIME_ZONES = [
  'Asia/Dubai',
  'Asia/Riyadh',
  'Europe/London',
  'Asia/Kolkata',
  'Asia/Seoul',
  'UTC',
] as const;

/** The zone list: the account's first, the event's own, then the common ones. */
export function timeZoneChoices(
  accountZone: string,
  current: string
): string[] {
  return [...new Set([accountZone, current, ...COMMON_TIME_ZONES])];
}

/** One entry of the repeat select. */
export type RepeatChoice =
  | 'none'
  | 'daily'
  | 'weekly'
  | 'monthlyDate'
  | 'monthlyNth'
  | 'monthlyLast'
  | 'yearly'
  | 'custom';

/** The first occurrence's date and zone, or null while the date is not one. */
export function anchorOfForm(v: EventFormValues): RepeatAnchor | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.startDate)) return null;
  try {
    anchorFacts({ date: v.startDate, timeZone: v.timeZone });
  } catch {
    return null;
  }
  return { date: v.startDate, timeZone: v.timeZone };
}

/** What the select shows for the form's repeat. */
export function repeatChoiceOf(v: EventFormValues): RepeatChoice {
  if (v.customRrule !== null) return 'custom';
  const r = v.repeat;
  if (r.freq === 'monthly') {
    return r.monthly === 'date'
      ? 'monthlyDate'
      : r.monthly === 'nth'
        ? 'monthlyNth'
        : 'monthlyLast';
  }
  return r.freq;
}

/**
 * The options offered: "the nth weekday" only up to the 4th (a 5th is
 * better said as "the last"), "the last weekday" only when the start is
 * one, a custom rule only while the event still has it; the current
 * choice is always offered.
 */
export function repeatChoices(v: EventFormValues): RepeatChoice[] {
  const current = repeatChoiceOf(v);
  const anchor = anchorOfForm(v);
  const facts = anchor ? anchorFacts(anchor) : null;
  const all: RepeatChoice[] = [
    'none',
    'daily',
    'weekly',
    'monthlyDate',
    'monthlyNth',
    'monthlyLast',
    'yearly',
    'custom',
  ];
  return all.filter((c) => {
    if (c === current) return true;
    if (c === 'custom') return false;
    if (c === 'monthlyNth') return !!facts && facts.nth <= 4;
    if (c === 'monthlyLast') return !!facts && facts.isLast;
    return true;
  });
}

/** Pick a repeat option; any choice but 'custom' replaces a kept custom rule. */
export function withRepeatChoice(
  v: EventFormValues,
  choice: RepeatChoice
): EventFormValues {
  if (choice === 'custom') return v;
  const r = { ...v.repeat };
  switch (choice) {
    case 'monthlyDate':
    case 'monthlyNth':
    case 'monthlyLast':
      r.freq = 'monthly';
      r.monthly =
        choice === 'monthlyDate'
          ? 'date'
          : choice === 'monthlyNth'
            ? 'nth'
            : 'last';
      break;
    case 'weekly': {
      r.freq = 'weekly';
      const anchor = anchorOfForm(v);
      if (!r.weekdays.length && anchor) {
        r.weekdays = [anchorFacts(anchor).weekday];
      }
      break;
    }
    default:
      r.freq = choice;
  }
  return { ...v, repeat: r, customRrule: null };
}

/**
 * The description model of one option as a label ("Monthly on day 15"):
 * every 1, never ending. Null when it cannot be described (no valid start
 * date, 'none', 'custom').
 */
export function choiceDescription(
  v: EventFormValues,
  choice: RepeatChoice
): RepeatDescription | null {
  if (choice === 'none' || choice === 'custom') return null;
  const anchor = anchorOfForm(v);
  if (!anchor) return null;
  const next = withRepeatChoice(v, choice).repeat;
  try {
    const body = formToRrule(
      { ...next, interval: 1, ends: 'never', until: null, count: null },
      anchor
    );
    return describeRrule(body, anchor);
  } catch {
    return null;
  }
}

/**
 * The live line under the picker: the rule the form would save, 'none'
 * when it does not repeat, 'invalid' when the picker's state cannot be
 * saved (the save shows why).
 */
export function repeatPreview(
  v: EventFormValues
): RepeatDescription | 'none' | 'invalid' {
  const anchor = anchorOfForm(v);
  if (!anchor) return v.repeat.freq === 'none' ? 'none' : 'invalid';
  try {
    const body = formRrule(v);
    return describeRrule(body, anchor) ?? 'none';
  } catch {
    return 'invalid';
  }
}

/** Unsaved changes: anything differs from the values the dialog opened with. */
export function formChanged(
  current: EventFormValues,
  initial: EventFormValues
): boolean {
  return JSON.stringify(current) !== JSON.stringify(initial);
}

export interface MemberLike {
  user_id: string;
  full_name: string | null;
  email: string | null;
  deactivated_at?: string | null;
}

/**
 * People the search offers: live, not already added, not excluded (the
 * organiser), matching the query by name or email. Nothing for an empty
 * query.
 */
export function attendeeCandidates<M extends MemberLike>(
  members: readonly M[],
  query: string,
  selected: readonly string[],
  exclude: readonly (string | null | undefined)[],
  limit = 8
): M[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const skip = new Set<string>([
    ...selected,
    ...exclude.filter((id): id is string => !!id),
  ]);
  return members
    .filter(
      (p) =>
        !p.deactivated_at &&
        !skip.has(p.user_id) &&
        ((p.full_name ?? '').toLowerCase().includes(q) ||
          (p.email ?? '').toLowerCase().includes(q))
    )
    .slice(0, limit);
}

/**
 * Where "Video meeting instead" starts the meeting: the form's start, or
 * 09:00 on its first day for an all-day event; undefined when the start
 * is not a valid time (the meeting form then uses its own default).
 */
export function meetingStartOf(v: EventFormValues): Date | undefined {
  const time = v.allDay ? '09:00' : v.startTime;
  return zonedWallTimeToInstant(v.startDate, time, v.timeZone) ?? undefined;
}
