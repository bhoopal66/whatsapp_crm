import { describe, expect, it } from 'vitest';

import {
  canSnoozeCase,
  inboxFiltersFromView,
  isValidSnoozeUntil,
  parseViews,
  snoozeLabel,
  snoozePresets,
  viewFiltersFromInbox,
  viewSortFromInbox,
} from './views-ui';
import { EMPTY_FILTERS, type InboxFilters } from './ui';

const FULL: InboxFilters = {
  bank: 'ADCB',
  stage: 'Under review',
  agent: 'u1',
  priority: 'urgent',
  slaState: 'overdue',
  customerWaiting: true,
  documentsMissing: true,
  bankQueryOpen: true,
  includeClosed: true,
  noActivityDays: 5,
  snoozed: 'only',
  mentionedMe: true,
  sort: 'stalest',
};

describe('views round trip', () => {
  it('never carries sort inside the filters and restores it from the view', () => {
    const filters = viewFiltersFromInbox(FULL);
    expect('sort' in filters).toBe(false);
    expect(viewSortFromInbox(FULL)).toBe('stalest');
    expect(inboxFiltersFromView({ filters, sort: 'stalest' })).toEqual(FULL);
  });

  it('maps a null sort to the inbox default, both ways', () => {
    expect(viewSortFromInbox(EMPTY_FILTERS)).toBeNull();
    expect(
      inboxFiltersFromView({
        filters: viewFiltersFromInbox(EMPTY_FILTERS),
        sort: null,
      })
    ).toEqual(EMPTY_FILTERS);
  });
});

describe('parseViews', () => {
  it('reads the API shape', () => {
    const views = parseViews({
      views: [
        {
          viewId: 'v1',
          ownerUserId: 'u1',
          name: 'Mine',
          filters: {
            bank: 'ADCB',
            slaState: 'overdue',
            snoozed: 'all',
            snoozeExpired: true,
            mentionedMe: true,
            noActivityDays: 7,
          },
          sort: 'due_soonest',
          shared: true,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-02T00:00:00.000Z',
        },
      ],
    });
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      viewId: 'v1',
      name: 'Mine',
      sort: 'due_soonest',
      shared: true,
    });
    expect(views[0].filters).toEqual({
      ...viewFiltersFromInbox(EMPTY_FILTERS),
      bank: 'ADCB',
      slaState: 'overdue',
      snoozed: 'all',
      mentionedMe: true,
      noActivityDays: 7,
    });
    expect(inboxFiltersFromView(views[0]).sort).toBe('due_soonest');
  });

  it('survives garbage and drops unknown values', () => {
    expect(parseViews(null)).toEqual([]);
    expect(parseViews({ views: 'x' })).toEqual([]);
    const [v] = parseViews({
      views: [
        null,
        { name: 'no id' },
        {
          viewId: 'v2',
          name: 'Odd',
          filters: { priority: 'asap', snoozed: 'maybe', noActivityDays: 0 },
          sort: 'random',
        },
      ],
    });
    expect(v.sort).toBeNull();
    expect(v.filters).toEqual(viewFiltersFromInbox(EMPTY_FILTERS));
  });
});

describe('snoozePresets (UTC+4, no DST)', () => {
  const tz = 'Asia/Dubai';
  const keys = (now: string) =>
    snoozePresets(new Date(now), tz).map((p) => [p.key, p.until.toISOString()]);

  it('is 09:00 local: tomorrow, +3 days, next Monday', () => {
    // Tue 20 Oct 2026 12:00 local.
    expect(keys('2026-10-20T08:00:00Z')).toEqual([
      ['tomorrow', '2026-10-21T05:00:00.000Z'],
      ['in3days', '2026-10-23T05:00:00.000Z'],
      ['nextWeek', '2026-10-26T05:00:00.000Z'],
    ]);
  });

  it('follows the local date just before and just after local midnight', () => {
    // 23:59 local Tue 20 Oct (19:59Z) vs 00:01 local Wed 21 Oct (20:01Z).
    expect(keys('2026-10-20T19:59:00Z')[0]).toEqual([
      'tomorrow',
      '2026-10-21T05:00:00.000Z',
    ]);
    expect(keys('2026-10-20T20:01:00Z')[0]).toEqual([
      'tomorrow',
      '2026-10-22T05:00:00.000Z',
    ]);
  });

  it('skips a whole week when today is Monday, and handles Sunday', () => {
    // Mon 26 Oct 2026 local.
    expect(keys('2026-10-26T08:00:00Z')[2]).toEqual([
      'nextWeek',
      '2026-11-02T05:00:00.000Z',
    ]);
    // Sun 25 Oct 2026 local.
    expect(keys('2026-10-25T08:00:00Z')[2]).toEqual([
      'nextWeek',
      '2026-10-26T05:00:00.000Z',
    ]);
  });

  it('always yields valid snoozes', () => {
    const now = new Date('2026-10-20T19:59:00Z');
    for (const p of snoozePresets(now, tz))
      expect(isValidSnoozeUntil(p.until, now)).toBe(true);
  });
});

describe('isValidSnoozeUntil', () => {
  const now = new Date('2026-10-20T08:00:00Z');
  const day = 86_400_000;
  it('is (now, now + 30 days]', () => {
    expect(isValidSnoozeUntil(now, now)).toBe(false);
    expect(isValidSnoozeUntil(new Date(now.getTime() + 1), now)).toBe(true);
    expect(isValidSnoozeUntil(new Date(now.getTime() + 30 * day), now)).toBe(
      true
    );
    expect(
      isValidSnoozeUntil(new Date(now.getTime() + 30 * day + 1), now)
    ).toBe(false);
    expect(isValidSnoozeUntil(new Date(now.getTime() - 1), now)).toBe(false);
    expect(isValidSnoozeUntil(new Date('nope'), now)).toBe(false);
  });
});

describe('snoozeLabel', () => {
  it('is null without a snooze and words an active and an ended one', () => {
    expect(
      snoozeLabel({ snoozedUntil: null, snoozeExpired: false }, 'en', 'UTC')
    ).toBeNull();
    expect(
      snoozeLabel({ snoozedUntil: 'bad', snoozeExpired: false }, 'en', 'UTC')
    ).toBeNull();
    const at = '2026-10-21T05:00:00.000Z';
    expect(
      snoozeLabel(
        { snoozedUntil: at, snoozeExpired: false },
        'en-GB',
        'Asia/Dubai'
      )
    ).toBe('Snoozed until 21 Oct, 09:00');
    expect(
      snoozeLabel(
        { snoozedUntil: at, snoozeExpired: true },
        'en-GB',
        'Asia/Dubai'
      )
    ).toBe('Snooze ended 21 Oct, 09:00');
  });
});

describe('canSnoozeCase', () => {
  it('lets coordinators and up snooze, not the agent', () => {
    expect(canSnoozeCase('super_admin')).toBe(true);
    expect(canSnoozeCase('admin')).toBe(true);
    expect(canSnoozeCase('team_lead')).toBe(true);
    expect(canSnoozeCase('coordinator')).toBe(true);
    expect(canSnoozeCase('agent')).toBe(false);
  });
});
