import { describe, expect, it } from 'vitest';

import {
  countdownParts,
  firstName,
  hubSections,
  liveElapsedMs,
  meetingHubTab,
  meetingIdFromLink,
  upcomingBadge,
} from './hub';
import { meetingScopeParam, type MeetingSummary } from './schedule';

const NOW = new Date('2026-10-15T08:00:00Z');
const ID = '3f2a9c1e-7b4d-4e21-9a10-5c6d7e8f9a0b';

const at = (minutes: number) =>
  new Date(NOW.getTime() + minutes * 60_000).toISOString();

const meeting = (over: Partial<MeetingSummary>): MeetingSummary => ({
  id: 'm',
  title: 'Sync',
  description: null,
  scheduledStart: at(60),
  scheduledEnd: at(90),
  hostUserId: 'h',
  openToWorkspace: false,
  status: 'scheduled',
  endedAt: null,
  createdAt: at(-600),
  inviteeUserIds: [],
  presentCount: 0,
  present: [],
  ...over,
});

describe('meetingHubTab', () => {
  it('shows Schedule for every scope but past', () => {
    expect(meetingHubTab(meetingScopeParam(undefined))).toBe('schedule');
    expect(meetingHubTab(meetingScopeParam('live'))).toBe('schedule');
    expect(meetingHubTab(meetingScopeParam('upcoming'))).toBe('schedule');
    expect(meetingHubTab(meetingScopeParam('past'))).toBe('past');
  });
});

describe('meetingIdFromLink', () => {
  it.each([
    ID,
    `  ${ID}\n`,
    ID.toUpperCase(),
    `/meetings/${ID}`,
    `/meetings/${ID}/room`,
    `/meetings/${ID}/?from=chat#x`,
    `https://crm.example.com/meetings/${ID}`,
    `http://localhost:3000/meetings/${ID}/room?x=1`,
  ])('reads %s', (text) => {
    expect(meetingIdFromLink(text)).toBe(ID);
  });

  it.each([
    '',
    'hello',
    ID.slice(1),
    `/meetings/${ID}/chat`,
    `/other/meetings/${ID}`,
    `//evil.example/meetings/${ID}`,
    `crm.example.com/meetings/${ID}`,
    `javascript:/meetings/${ID}`,
    'https://crm.example.com/meetings/not-a-uuid',
  ])('refuses %s', (text) => {
    expect(meetingIdFromLink(text)).toBeNull();
  });
});

describe('countdownParts', () => {
  it('splits what is left', () => {
    expect(countdownParts(at(135), NOW)).toEqual({
      past: false,
      days: 0,
      hours: 2,
      minutes: 15,
    });
    expect(countdownParts(at(1440 + 61), NOW)).toMatchObject({
      days: 1,
      hours: 1,
      minutes: 1,
    });
  });

  it('rounds up, so it never reads zero before the moment', () => {
    const soon = new Date(NOW.getTime() + 5_000).toISOString();
    expect(countdownParts(soon, NOW)).toMatchObject({
      past: false,
      minutes: 1,
    });
  });

  it('stops at the moment and on an unreadable date', () => {
    expect(countdownParts(at(0), NOW).past).toBe(true);
    expect(countdownParts(at(-5), NOW).past).toBe(true);
    expect(countdownParts('nope', NOW).past).toBe(true);
  });
});

describe('hubSections', () => {
  it('lists a meeting in both reads once, under live', () => {
    const stale = meeting({ id: 'a' });
    const fresh = meeting({ id: 'a', presentCount: 2 });
    const s = hubSections([fresh], [stale], NOW);
    expect(s.live).toEqual([fresh]);
    expect(s.upcoming).toEqual([]);
    expect(s.nextUp).toBeNull();
  });

  it('moves a row that went live and drops one that lapsed', () => {
    const live = meeting({ id: 'a', presentCount: 1 });
    const lapsed = meeting({
      id: 'b',
      scheduledStart: at(-60),
      scheduledEnd: at(-30),
    });
    const s = hubSections([], [live, lapsed], NOW);
    expect(s.live.map((m) => m.id)).toEqual(['a']);
    expect(s.upcoming).toEqual([]);
  });

  it('picks a due meeting before a later one, never an instant one', () => {
    const instant = meeting({
      id: 'i',
      scheduledStart: null,
      scheduledEnd: null,
    });
    const later = meeting({ id: 'l', scheduledStart: at(5) });
    const due = meeting({ id: 'd', scheduledStart: at(-5) });
    expect(hubSections([], [instant, later, due], NOW).nextUp?.id).toBe('d');
    expect(hubSections([], [instant, later], NOW).nextUp?.id).toBe('l');
    expect(hubSections([], [instant], NOW).nextUp).toBeNull();
  });
});

describe('upcomingBadge', () => {
  it('counts down only when close', () => {
    expect(upcomingBadge(meeting({ scheduledStart: at(12) }), NOW)).toBe(
      'soon'
    );
    expect(
      upcomingBadge(
        meeting({ scheduledStart: at(600), scheduledEnd: at(630) }),
        NOW
      )
    ).toBeNull();
  });

  it('says due once the time has come, an instant meeting included', () => {
    expect(upcomingBadge(meeting({ scheduledStart: at(-2) }), NOW)).toBe('due');
    expect(
      upcomingBadge(meeting({ scheduledStart: null, scheduledEnd: null }), NOW)
    ).toBe('due');
  });
});

describe('liveElapsedMs', () => {
  it('runs from the start, an instant meeting from its creation', () => {
    expect(liveElapsedMs(meeting({ scheduledStart: at(-12) }), NOW)).toBe(
      720_000
    );
    expect(
      liveElapsedMs(meeting({ scheduledStart: null, createdAt: at(-3) }), NOW)
    ).toBe(180_000);
  });

  it('has nothing to say when people joined early', () => {
    expect(liveElapsedMs(meeting({ scheduledStart: at(5) }), NOW)).toBeNull();
  });
});

describe('firstName', () => {
  it('takes the first word', () => {
    expect(firstName('  Hala Mansour ')).toBe('Hala');
    expect(firstName('')).toBe('');
    expect(firstName(null)).toBe('');
  });
});
