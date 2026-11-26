import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import { alarmFor, type Alarm } from '@/lib/reminders/alarm';
import type { Notification } from '@/types';

// Node tests cannot mount a component: the cards render server-side with
// the real catalogue, and the buttons' work is alarmActions(), called
// directly. The queue's rules are lib/reminders/alarm.test.ts.

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: toastMock }));

import {
  ReminderAlarmCard,
  ReminderAlarmStack,
  SnoozeRow,
  alarmActions,
  alarmNotificationTag,
  canManageAlarm,
  type AlarmActions,
} from './reminder-alarm';

const TASK = '3f1b2a34-0c6e-4f4e-9a55-0d8f2f6b1a11';
const MEETING = '4a2c3b45-1d7f-4a5f-8b66-1e9a3a7c2b22';
const EVENT = '5b3d4c56-2e8a-4b6a-9c77-2fab4b8d3c33';
const NOW = Date.parse('2026-11-12T10:00:00Z');

function row(over: Partial<Notification> = {}): Notification {
  return {
    id: 'n1',
    account_id: 'ws-a',
    user_id: 'u1',
    type: 'task_due',
    title: 'Call Fatima back',
    body: 'About the card limit',
    meta: { task_id: TASK, offset: 0 },
    read_at: null,
    created_at: new Date(NOW - 30_000).toISOString(),
    ...over,
  } as Notification;
}

function alarm(over: Partial<Notification> = {}, missed = false): Alarm {
  const a = alarmFor(row(over), NOW);
  if (!a) throw new Error('row does not ring');
  return { ...a, missed };
}

const meetingAlarm = () =>
  alarm({
    type: 'meeting_reminder',
    title: 'Weekly sync',
    meta: { meeting_id: MEETING, offset: 0 },
  });
const eventAlarm = () =>
  alarm({
    type: 'event_reminder',
    title: 'Bank visit',
    meta: { event_id: EVENT, offset: 10 },
  });

const noActions: AlarmActions = {
  open: () => {},
  dismiss: () => {},
  snooze: async () => {},
  done: async () => {},
};

function wrap(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      {node}
    </NextIntlClientProvider>
  );
}

function card(a: Alarm, activeWorkspaceId: string | null = 'ws-a') {
  return wrap(
    <ReminderAlarmCard
      alarm={a}
      manageable={canManageAlarm(a, activeWorkspaceId)}
      actions={noActions}
    />
  );
}

describe('ReminderAlarmCard', () => {
  it('a task rings as a Reminder with Snooze, Done and Open', () => {
    const html = card(alarm());
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-reminder-alarm="task"');
    expect(html).toContain('border-warning');
    expect(html).toContain('>Reminder<');
    expect(html).toContain('Call Fatima back');
    expect(html).toContain('About the card limit');
    expect(html).toContain('>Snooze<');
    expect(html).toContain('>Done<');
    expect(html).toContain('>Open<');
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).toContain('data-alarm-ping');
  });

  it('a task of another workspace offers Open and Dismiss only', () => {
    const html = card(alarm({ account_id: 'ws-b' }), 'ws-a');
    expect(html).toContain('>Open<');
    expect(html).toContain('>Dismiss<');
    expect(html).not.toContain('>Snooze<');
    expect(html).not.toContain('>Done<');
  });

  it('a task whose workspace is not known yet is still managed', () => {
    expect(card(alarm(), null)).toContain('>Snooze<');
  });

  it('a meeting rings with Join and Dismiss, in the info colours', () => {
    const html = card(meetingAlarm());
    expect(html).toContain('data-reminder-alarm="meeting"');
    expect(html).toContain('border-info');
    expect(html).toContain('>Meeting<');
    expect(html).toContain('>Join<');
    expect(html).toContain('>Dismiss<');
    expect(html).not.toContain('>Snooze<');
  });

  it('an event rings with Open and Dismiss, violet in both modes', () => {
    const html = card(eventAlarm());
    expect(html).toContain('data-reminder-alarm="event"');
    expect(html).toContain('border-violet-500 dark:border-violet-400');
    expect(html).toContain('>Event<');
    expect(html).toContain('>Open<');
    expect(html).toContain('>Dismiss<');
    expect(html).not.toContain('>Done<');
  });

  it('a missed alarm carries the badge and no ping ring', () => {
    const html = card(alarm({}, true));
    expect(html).toContain('>Missed<');
    expect(html).toContain('data-alarm-time');
    expect(html).not.toContain('data-alarm-ping');
    expect(card(alarm())).not.toContain('>Missed<');
    expect(card(alarm())).not.toContain('data-alarm-time');
  });
});

describe('ReminderAlarmStack', () => {
  const render = (shown: Alarm[], hidden: number) =>
    wrap(
      <ReminderAlarmStack
        shown={shown}
        hidden={hidden}
        renderCard={(a) => <span>{a.title}</span>}
      />
    );

  it('counts the cards behind the stack', () => {
    const html = render([alarm(), meetingAlarm(), eventAlarm()], 2);
    expect(html).toContain('+2 more');
    expect(html).toContain('top-[68px] end-4 z-[56]');
    // On a phone, above the bottom tab bar (3.5rem), not under it.
    expect(html).toContain(
      'max-sm:bottom-[calc(4.25rem+env(safe-area-inset-bottom))]'
    );
  });

  it('has no count line with nothing hidden, and nothing when empty', () => {
    expect(render([alarm()], 0)).not.toContain('more');
    expect(render([], 0)).toBe('');
  });
});

describe('alarmNotificationTag', () => {
  it('uses the push tags of migration 197', () => {
    expect(alarmNotificationTag(alarm())).toBe(`task:${TASK}`);
    expect(alarmNotificationTag(meetingAlarm())).toBe('bell:n1');
  });
});

describe('alarmActions', () => {
  const fetchMock = vi.fn();
  const markRead = vi.fn(async () => {});
  const openNotification = vi.fn(async () => {});
  const remove = vi.fn();
  const plan = { href: '/contacts/c1', otherWorkspace: null };
  const t = (key: string, values?: Record<string, string | number>) =>
    values ? `${key}:${JSON.stringify(values)}` : key;

  const readTask = vi.fn();
  const actions = (a = alarm()) =>
    alarmActions({
      alarm: a,
      plan,
      markRead,
      openNotification,
      remove,
      t,
      formatWhen: (d) => d.toISOString(),
      timeZone: 'Asia/Dubai',
      now: () => new Date(NOW),
      readTask,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    readTask.mockResolvedValue({
      status: 'open',
      due_at: new Date(alarm().createdAt).toISOString(),
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('Open opens the planned screen and takes the card off', () => {
    actions().open();
    expect(openNotification).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'n1' }),
      plan
    );
    expect(remove).toHaveBeenCalledWith('n1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Dismiss reads the row and takes the card off', () => {
    actions().dismiss();
    expect(markRead).toHaveBeenCalledWith('n1');
    expect(remove).toHaveBeenCalledWith('n1');
  });

  it('Snooze moves the due time, then reads the row', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await actions().snooze('10m');
    expect(fetchMock).toHaveBeenCalledWith(`/api/tasks/${TASK}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dueAt: new Date(NOW + 10 * 60 * 1000).toISOString(),
      }),
    });
    expect(markRead).toHaveBeenCalledWith('n1');
    expect(remove).toHaveBeenCalledWith('n1');
    expect(toastMock.success).toHaveBeenCalledWith(
      `snoozedUntil:${JSON.stringify({ when: new Date(NOW + 600_000).toISOString() })}`
    );
  });

  it('Done closes the task, then reads the row', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await actions().done();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${TASK}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ status: 'done' }),
      })
    );
    expect(markRead).toHaveBeenCalledWith('n1');
    expect(toastMock.success).toHaveBeenCalledWith('doneToast');
  });

  it.each([
    ['moved to a later time', 'open', 3_600_000],
    ['finished elsewhere', 'done', 0],
  ])('Done leaves a task that was %s alone', async (_, status, later) => {
    readTask.mockResolvedValue({
      status,
      due_at: new Date(alarm().createdAt + later).toISOString(),
    });
    await actions().done();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toastMock.info).toHaveBeenCalledWith('changed');
    expect(markRead).toHaveBeenCalledWith('n1');
    expect(remove).toHaveBeenCalledWith('n1');
  });

  it('Done on a task that cannot be read keeps the card and says so', async () => {
    readTask.mockRejectedValue(new Error('offline'));
    await actions().done();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith('failed');
    expect(remove).not.toHaveBeenCalled();
  });

  it('Join on a meeting starting now opens its lobby', () => {
    const a = meetingAlarm();
    actions(a).open();
    expect(openNotification).toHaveBeenCalledWith(a.row, {
      ...plan,
      href: `/meetings/${MEETING}/room`,
    });
    expect(remove).toHaveBeenCalledWith('n1');
  });

  it('Join on a meeting with no offset opens its lobby too', () => {
    const a = alarm({
      type: 'meeting_reminder',
      meta: { meeting_id: MEETING },
    });
    actions(a).open();
    expect(openNotification).toHaveBeenCalledWith(a.row, {
      ...plan,
      href: `/meetings/${MEETING}/room`,
    });
  });

  it('Join on the 10-minute heads-up keeps the planned meeting page', () => {
    const a = alarm({
      type: 'meeting_reminder',
      meta: { meeting_id: MEETING, offset: 10 },
    });
    actions(a).open();
    expect(openNotification).toHaveBeenCalledWith(a.row, plan);
  });

  it('a refused or failed PATCH keeps the card and says so', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });
    await actions().done();
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await actions().snooze('1h');
    expect(toastMock.error).toHaveBeenCalledTimes(2);
    expect(toastMock.error).toHaveBeenCalledWith('failed');
    expect(markRead).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('SnoozeRow', () => {
  it('offers Back before the three times', () => {
    const html = wrap(
      <SnoozeRow pending={false} onPick={() => {}} onBack={() => {}} />
    );
    expect(html).toContain('data-snooze-back');
    expect(html).toContain('>Back<');
    expect(html.indexOf('>Back<')).toBeLessThan(html.indexOf('>10 minutes<'));
    expect(html).toContain('>1 hour<');
    expect(html).toContain('>Tomorrow 9:00<');
  });

  it('Back stays usable while a snooze is pending', () => {
    const html = wrap(
      <SnoozeRow pending onPick={() => {}} onBack={() => {}} />
    );
    expect(html).toContain('data-snooze-back');
    expect(html).not.toMatch(/data-snooze-back[^>]*disabled=/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>10 minutes/);
  });
});
