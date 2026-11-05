// ============================================================
// The /meetings home's pure logic: which tab a scope shows, reading a
// pasted link, the countdown, and the default view's sections. No I/O,
// no clock: `now` is always passed in.
// ============================================================

import { isUuid } from './requests';
import {
  meetingDisplayStatus,
  type MeetingScope,
  type MeetingSummary,
} from './schedule';

export type MeetingHubTab = 'schedule' | 'past';

/** `?scope=live` and `?scope=upcoming` stay valid links to Schedule. */
export function meetingHubTab(scope: MeetingScope): MeetingHubTab {
  return scope === 'past' ? 'past' : 'schedule';
}

const MEETING_PATH_RE = /^\/meetings\/([^/]+)(?:\/room)?\/?$/;

const uuidOrNull = (v: string | undefined) =>
  isUuid(v) ? v.toLowerCase() : null;

/** The id in a full URL, a `/meetings/<uuid>[/room]` path or a bare uuid. */
export function meetingIdFromLink(text: string): string | null {
  const input = text.trim();
  const bare = uuidOrNull(input);
  if (bare) return bare;
  let path: string;
  if (input.startsWith('/')) {
    path = input.split(/[?#]/)[0];
  } else {
    try {
      const url = new URL(input);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      path = url.pathname;
    } catch {
      return null;
    }
  }
  return uuidOrNull(MEETING_PATH_RE.exec(path)?.[1]);
}

export interface CountdownParts {
  /** The moment has come: nothing left to count. */
  past: boolean;
  days: number;
  hours: number;
  minutes: number;
}

/** Time left, rounded up: "1 min" until the moment itself. */
export function countdownParts(target: string, now: Date): CountdownParts {
  const ms = Date.parse(target) - now.getTime();
  if (!(ms > 0)) return { past: true, days: 0, hours: 0, minutes: 0 };
  const total = Math.ceil(ms / 60_000);
  return {
    past: false,
    days: Math.floor(total / 1440),
    hours: Math.floor((total % 1440) / 60),
    minutes: total % 60,
  };
}

export interface HubSections {
  live: MeetingSummary[];
  upcoming: MeetingSummary[];
  /** The rail's card: the next meeting with a time, due ones first. */
  nextUp: MeetingSummary | null;
}

/**
 * Sorts the two reads into sections by what each meeting is doing now:
 * they are separate requests, so one meeting can be in both, and a row
 * can go live or lapse between re-reads.
 */
export function hubSections(
  live: readonly MeetingSummary[],
  upcoming: readonly MeetingSummary[],
  now: Date
): HubSections {
  const byId = new Map(upcoming.map((m) => [m.id, m]));
  for (const m of live) byId.set(m.id, m);
  const sections: HubSections = { live: [], upcoming: [], nextUp: null };
  for (const m of byId.values()) {
    const status = meetingDisplayStatus(m, now);
    if (status === 'live') sections.live.push(m);
    else if (status === 'due' || status === 'scheduled')
      sections.upcoming.push(m);
  }
  const timed = sections.upcoming.filter((m) => m.scheduledStart);
  sections.nextUp =
    timed.find((m) => meetingDisplayStatus(m, now) === 'due') ??
    timed[0] ??
    null;
  return sections;
}

/** Closer than this, a Coming up row counts down. */
export const STARTS_SOON_MS = 2 * 60 * 60_000;

/** A Coming up row's badge: due, starting soon, or none. */
export function upcomingBadge(
  m: MeetingSummary,
  now: Date
): 'due' | 'soon' | null {
  if (meetingDisplayStatus(m, now) === 'due') return 'due';
  if (!m.scheduledStart) return null;
  return Date.parse(m.scheduledStart) - now.getTime() <= STARTS_SOON_MS
    ? 'soon'
    : null;
}

/** How long a live meeting has run; null if people joined before its time. */
export function liveElapsedMs(m: MeetingSummary, now: Date): number | null {
  const from = m.scheduledStart ?? m.createdAt;
  if (!from) return null;
  const ms = now.getTime() - Date.parse(from);
  return ms >= 0 ? ms : null;
}

/** "Hala Mansour" → "Hala"; empty for a blank name. */
export function firstName(fullName: string | null | undefined): string {
  return fullName?.trim().split(/\s+/)[0] ?? '';
}
