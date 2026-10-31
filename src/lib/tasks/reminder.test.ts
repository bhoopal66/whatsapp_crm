import { describe, expect, it } from 'vitest';

import type { Profile } from '@/types';

import {
  canMarkReminderDone,
  parseCustomReminderDue,
  savedToastKey,
  REMINDER_HOUR,
  REMINDER_PRESETS,
  reminderAssignees,
  reminderDueAt,
  upcomingReminders,
  type UpcomingReminder,
} from './reminder';

// Local times: the helpers work on the browser's clock.
const at = (y: number, mo: number, d: number, h = 14, mi = 30) =>
  new Date(y, mo - 1, d, h, mi, 0, 0);

const ymdh = (x: Date) => [
  x.getFullYear(),
  x.getMonth() + 1,
  x.getDate(),
  x.getHours(),
  x.getMinutes(),
];

describe('reminderDueAt', () => {
  const now = at(2026, 10, 31);

  it('lands every preset at 09:00 local', () => {
    for (const p of REMINDER_PRESETS) {
      const due = reminderDueAt(p, now);
      expect(due.getHours()).toBe(REMINDER_HOUR);
      expect(due.getMinutes()).toBe(0);
      expect(due.getSeconds()).toBe(0);
    }
  });

  it('counts days and months from today', () => {
    expect(ymdh(reminderDueAt('tomorrow', now))).toEqual([2026, 11, 1, 9, 0]);
    expect(ymdh(reminderDueAt('in1week', now))).toEqual([2026, 11, 7, 9, 0]);
    expect(ymdh(reminderDueAt('in3months', at(2026, 3, 15)))).toEqual([
      2026, 6, 15, 9, 0,
    ]);
    expect(ymdh(reminderDueAt('in1month', at(2026, 12, 10)))).toEqual([
      2027, 1, 10, 9, 0,
    ]);
  });

  it('clamps a month to its last day instead of spilling over', () => {
    expect(ymdh(reminderDueAt('in1month', at(2026, 1, 31)))).toEqual([
      2026, 2, 28, 9, 0,
    ]);
    expect(ymdh(reminderDueAt('in1month', at(2028, 1, 31)))).toEqual([
      2028, 2, 29, 9, 0,
    ]);
    expect(ymdh(reminderDueAt('in3months', now))).toEqual([2027, 1, 31, 9, 0]);
    expect(ymdh(reminderDueAt('in3months', at(2026, 11, 30)))).toEqual([
      2027, 2, 28, 9, 0,
    ]);
  });

  it('is always after now, even late at night', () => {
    const late = at(2026, 10, 31, 23, 59);
    for (const p of REMINDER_PRESETS) {
      expect(reminderDueAt(p, late).getTime()).toBeGreaterThan(late.getTime());
    }
  });
});

describe('reminderAssignees', () => {
  const p = (
    user_id: string,
    account_role: Profile['account_role'],
    extra: Partial<Profile> = {}
  ): Profile =>
    ({
      id: `p-${user_id}`,
      user_id,
      full_name: user_id,
      account_role,
      ...extra,
    }) as Profile;

  it('keeps people who can hold a task, the caller first', () => {
    const list = [
      p('ann', 'agent'),
      p('me', 'team_leader'),
      p('vic', 'viewer'),
      p('own', 'owner'),
      p('gone', 'agent', { deactivated_at: '2026-01-01T00:00:00Z' }),
      p('norole', undefined),
    ];
    expect(reminderAssignees(list, 'me').map((x) => x.user_id)).toEqual([
      'me',
      'ann',
      'own',
    ]);
  });
});

describe('upcomingReminders', () => {
  const r = (
    id: string,
    due_at: string | null,
    status: UpcomingReminder['status'] = 'open'
  ): UpcomingReminder => ({
    id,
    title: id,
    due_at,
    assigned_to: null,
    created_by: null,
    status,
  });

  it('keeps open dated tasks, soonest first', () => {
    const out = upcomingReminders([
      r('late', '2026-12-01T09:00:00Z'),
      r('undated', null),
      r('done', '2026-11-01T09:00:00Z', 'done'),
      r('soon', '2026-11-02T09:00:00Z'),
      r('bad', 'not a date'),
    ]);
    expect(out.map((x) => x.id)).toEqual(['soon', 'late']);
  });
});

describe('parseCustomReminderDue', () => {
  const now = at(2026, 10, 31, 14, 0);
  const local = (x: Date) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}T${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;

  it('refuses a time under 15 minutes away', () => {
    const r = parseCustomReminderDue(local(at(2026, 10, 31, 14, 5)), now);
    expect(r).toEqual({ ok: false, reason: 'tooSoon' });
  });

  it('accepts 20 minutes ahead', () => {
    const r = parseCustomReminderDue(local(at(2026, 10, 31, 14, 20)), now);
    expect(r.ok).toBe(true);
  });

  it('keeps the past and invalid reasons', () => {
    expect(parseCustomReminderDue(local(at(2026, 10, 31, 13, 0)), now)).toEqual(
      { ok: false, reason: 'past' }
    );
    expect(parseCustomReminderDue('nope', now)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('savedToastKey', () => {
  it('names a colleague only when the reminder is for someone else', () => {
    expect(savedToastKey('me', 'me')).toBe('saved');
    expect(savedToastKey('', 'me')).toBe('saved');
    expect(savedToastKey(null, 'me')).toBe('saved');
    expect(savedToastKey('ann', 'me')).toBe('savedFor');
  });
});

describe('canMarkReminderDone', () => {
  const task = { assigned_to: 'ann', created_by: 'bob' };
  it('allows the assignee and the creator', () => {
    expect(canMarkReminderDone(task, 'ann', 'agent')).toBe(true);
    expect(canMarkReminderDone(task, 'bob', 'agent')).toBe(true);
  });
  it('allows an admin or owner', () => {
    expect(canMarkReminderDone(task, 'cat', 'admin')).toBe(true);
    expect(canMarkReminderDone(task, 'cat', 'owner')).toBe(true);
  });
  it('refuses anyone else, and a system task for an agent', () => {
    expect(canMarkReminderDone(task, 'cat', 'agent')).toBe(false);
    expect(canMarkReminderDone(task, 'cat', 'team_leader')).toBe(false);
    expect(
      canMarkReminderDone(
        { assigned_to: null, created_by: null },
        'cat',
        'agent'
      )
    ).toBe(false);
    expect(canMarkReminderDone(task, null, null)).toBe(false);
  });
});
