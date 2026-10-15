import { describe, expect, it } from 'vitest';

import { PUSH_KINDS } from './kinds';
import {
  DEFAULT_PUSH_PREFERENCES,
  groupedPushKinds,
  isKindOn,
  kindGroup,
  parsePushPreferences,
  preferencesToSave,
} from './settings';

describe('push kind groups', () => {
  it('puts every kind under exactly one heading', () => {
    const listed = groupedPushKinds().flatMap((g) => g.kinds);
    expect([...listed].sort()).toEqual([...PUSH_KINDS].sort());
  });

  it('groups by the settings headings', () => {
    expect(kindGroup('whatsapp_message')).toBe('messages');
    expect(kindGroup('chat_message')).toBe('messages');
    expect(kindGroup('meeting_invite')).toBe('meetings');
    expect(kindGroup('event_reminder')).toBe('meetings');
    expect(kindGroup('calendar_changed')).toBe('meetings');
    expect(kindGroup('task_assigned')).toBe('tasksCalls');
    expect(kindGroup('call_missed')).toBe('tasksCalls');
    expect(kindGroup('callback_requested')).toBe('tasksCalls');
    expect(kindGroup('channel_disconnected')).toBe('team');
  });
});

describe('preferences', () => {
  it('a missing kind is on, false is off', () => {
    const p = { ...DEFAULT_PUSH_PREFERENCES, kinds: { call_missed: false } };
    expect(isKindOn(p, 'call_missed')).toBe(false);
    expect(isKindOn(p, 'task_due')).toBe(true);
  });

  it('holds back half-filled quiet hours', () => {
    const base = { ...DEFAULT_PUSH_PREFERENCES, timeZone: 'Asia/Dubai' };
    expect(preferencesToSave({ ...base, quietStart: '22:00' })).toBeNull();
    expect(
      preferencesToSave({ ...base, quietStart: '22:00', quietEnd: '22:00' })
    ).toBeNull();
    expect(
      preferencesToSave({
        ...base,
        quietStart: '22:00',
        quietEnd: '07:00',
        timeZone: null,
      })
    ).toBeNull();
    expect(
      preferencesToSave({ ...base, quietStart: '22:00', quietEnd: '07:00' })
    ).toMatchObject({
      quietStart: '22:00',
      quietEnd: '07:00',
      timeZone: 'Asia/Dubai',
    });
  });

  it('drops the zone when there are no quiet hours', () => {
    expect(
      preferencesToSave({
        ...DEFAULT_PUSH_PREFERENCES,
        timeZone: 'Asia/Dubai',
        quietStart: '',
        quietEnd: '',
      })
    ).toEqual({ ...DEFAULT_PUSH_PREFERENCES, timeZone: null });
  });

  it('parses the GET body defensively', () => {
    expect(parsePushPreferences(null)).toEqual(DEFAULT_PUSH_PREFERENCES);
    expect(
      parsePushPreferences({
        enabled: false,
        kinds: { call_missed: false, bogus: false, task_due: 'no' },
        quietStart: '22:00',
        quietEnd: '07:00',
        timeZone: 'Asia/Dubai',
      })
    ).toEqual({
      enabled: false,
      kinds: { call_missed: false },
      quietStart: '22:00',
      quietEnd: '07:00',
      timeZone: 'Asia/Dubai',
    });
  });
});
