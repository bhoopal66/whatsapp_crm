import { describe, expect, it } from 'vitest';

import type { UserPresence } from './pbx/calls';
import {
  applyPhoneChange,
  liveliest,
  mergePhoneSnapshot,
  PERSON_PRESENCE_KEY,
  personPresence,
  presenceOf,
  samePhonePresence,
  type PhonePresenceRow,
} from './person-presence';

const row = (p: Partial<PhonePresenceRow> = {}): PhonePresenceRow => ({
  connection_id: 'c1',
  extension: '201',
  user_id: 'u1',
  presence: null,
  call_state: null,
  updated_at: '2026-10-13T10:00:00Z',
  ...p,
});
const phone = (state: UserPresence['state']): UserPresence => ({
  state,
  extension: '201',
  updatedAt: '2026-10-13T10:00:00Z',
});

describe('personPresence', () => {
  it('puts a call above everything the app says', () => {
    expect(personPresence('on_call', 'online')).toBe('on_call');
    expect(personPresence('on_call', 'offline')).toBe('on_call');
  });

  it('shows the status chosen on the phone', () => {
    expect(personPresence('dnd', 'online')).toBe('dnd');
    expect(personPresence('away', 'online')).toBe('away');
    expect(personPresence('off_work', 'online')).toBe('off_work');
  });

  it("falls through to the app on the phone's default or a stale row", () => {
    expect(personPresence('available', 'offline')).toBe('offline');
    expect(personPresence('available', 'away')).toBe('away');
    expect(personPresence('offline', 'online')).toBe('online');
  });

  it('is the app alone without a phone row', () => {
    expect(personPresence(undefined, 'online')).toBe('online');
    expect(personPresence(null, 'away')).toBe('away');
    expect(personPresence(undefined, undefined)).toBe('offline');
  });

  it('looks a person up in both sources', () => {
    const app = (id: string) => (id === 'U1' ? 'online' : 'offline');
    // No phone row: the app's own presence, never a blanket "offline".
    expect(presenceOf('U1', {}, app)).toBe('online');
    expect(presenceOf('U1', { u1: phone('on_call') }, app)).toBe('on_call');
    expect(presenceOf('U2', { u1: phone('dnd') }, app)).toBe('offline');
  });

  it('labels every state', () => {
    expect(PERSON_PRESENCE_KEY.dnd).toBe('dnd');
    expect(PERSON_PRESENCE_KEY.online).toBe('available');
  });

  it('shows the liveliest member of a group', () => {
    expect(liveliest(['offline', 'on_call', 'online'])).toBe('online');
    expect(liveliest(['away', 'dnd', 'off_work'])).toBe('dnd');
    expect(liveliest([])).toBe('offline');
  });
});

describe('live phone rows', () => {
  it('applies inserts and updates by (connection, extension), newest wins', () => {
    let rows = applyPhoneChange(new Map(), { eventType: 'INSERT', new: row() });
    rows = applyPhoneChange(rows, {
      eventType: 'UPDATE',
      new: row({ call_state: 'busy', updated_at: '2026-10-13T10:00:05Z' }),
    });
    expect([...rows.values()]).toEqual([
      row({ call_state: 'busy', updated_at: '2026-10-13T10:00:05Z' }),
    ]);
    const same = applyPhoneChange(rows, {
      eventType: 'UPDATE',
      new: row({ call_state: 'idle', updated_at: '2026-10-13T09:59:00Z' }),
    });
    expect(same).toBe(rows);
    expect(
      applyPhoneChange(rows, { eventType: 'UPDATE', new: { extension: '1' } })
    ).toBe(rows);
  });

  it('removes a deleted row from its key alone', () => {
    const rows = applyPhoneChange(new Map(), {
      eventType: 'INSERT',
      new: row(),
    });
    expect(
      applyPhoneChange(rows, {
        eventType: 'DELETE',
        old: { connection_id: 'c1', extension: '201' },
      }).size
    ).toBe(0);
    expect(
      applyPhoneChange(rows, {
        eventType: 'DELETE',
        old: { connection_id: 'c2', extension: '201' },
      })
    ).toBe(rows);
  });

  it('lets a read decide which rows exist, keeping a newer live row', () => {
    const live = applyPhoneChange(
      applyPhoneChange(new Map(), { eventType: 'INSERT', new: row() }),
      {
        eventType: 'INSERT',
        new: row({ extension: '202', updated_at: '2026-10-13T10:00:09Z' }),
      }
    );
    const merged = mergePhoneSnapshot(live, [
      row({ extension: '202', presence: 'lunch' }),
      row({ extension: '203' }),
    ]);
    expect([...merged.keys()]).toEqual(['c1:202', 'c1:203']);
    expect(merged.get('c1:202')?.updated_at).toBe('2026-10-13T10:00:09Z');
  });

  it('compares the states a dot shows', () => {
    expect(samePhonePresence({ u1: phone('dnd') }, { u1: phone('dnd') })).toBe(
      true
    );
    expect(
      samePhonePresence({ u1: phone('dnd') }, { u1: phone('on_call') })
    ).toBe(false);
    expect(samePhonePresence({}, { u1: phone('dnd') })).toBe(false);
  });
});
