import { describe, expect, it } from 'vitest';

import { listRooms, parseRoomScope } from './reads';
import { memoryDb } from './test-db';

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const D1 = '33333333-3333-4333-8333-333333333333';

const room = (
  id: string,
  contactId: string,
  dealId: string | null,
  at: string
) => ({
  id,
  channel_id: `chan-${id}`,
  contact_id: contactId,
  deal_id: dealId,
  subject: `Room ${id}`,
  status: 'open',
  participant_count: 3,
  window_until: null,
  created_at: at,
  deal: dealId ? { title: 'Home loan' } : null,
  contact: { name: 'Aisha' },
});

const guestRoom = {
  id: 'g-1',
  channel_id: 'chan-g-1',
  subject: 'Guest room',
  status: 'open',
  participant_count: 2,
  window_until: null,
  created_at: '2026-10-03T00:00:00Z',
};

const seed = () =>
  memoryDb({
    deal_rooms: [
      room('r-1', C1, D1, '2026-10-01T00:00:00Z'),
      room('r-2', C1, null, '2026-10-02T00:00:00Z'),
      room('r-3', C2, null, '2026-10-04T00:00:00Z'),
    ],
    deal_room_guest_rooms: [guestRoom],
  });

describe('parseRoomScope', () => {
  const parse = (q: string) => parseRoomScope(new URLSearchParams(q));

  it('reads one contact or one deal, and nothing as the whole list', () => {
    expect(parse('')).toEqual({ ok: true, scope: null });
    expect(parse(`contactId=${C1}`)).toEqual({
      ok: true,
      scope: { contactId: C1 },
    });
    expect(parse(`dealId=${D1}`)).toEqual({ ok: true, scope: { dealId: D1 } });
  });

  it('refuses both at once, or an id that is not a uuid', () => {
    expect(parse(`contactId=${C1}&dealId=${D1}`).ok).toBe(false);
    expect(parse('contactId=abc').ok).toBe(false);
    expect(parse('dealId=1%20or%201=1').ok).toBe(false);
  });
});

describe('listRooms', () => {
  it("lists everything the caller sees, newest first, staff's with their ids", async () => {
    const { db } = seed();
    const list = await listRooms(db);
    expect(list.map((r) => r.id)).toEqual(['r-3', 'g-1', 'r-2', 'r-1']);
    expect(list.find((r) => r.id === 'r-1')).toMatchObject({
      contactId: C1,
      dealId: D1,
      dealTitle: 'Home loan',
      contactName: 'Aisha',
    });
    expect(list.find((r) => r.id === 'g-1')).toMatchObject({
      contactId: null,
      dealId: null,
    });
  });

  it("lists one contact's rooms, without the guest view", async () => {
    const { db, log } = seed();
    const list = await listRooms(db, { contactId: C1 });
    expect(list.map((r) => r.id)).toEqual(['r-2', 'r-1']);
    expect(log.map((q) => q.table)).toEqual(['deal_rooms']);
    expect(log[0].eq).toEqual({ contact_id: C1 });
  });

  it("lists one deal's rooms", async () => {
    const { db, log } = seed();
    const list = await listRooms(db, { dealId: D1 });
    expect(list.map((r) => r.id)).toEqual(['r-1']);
    expect(log[0].eq).toEqual({ deal_id: D1 });
  });
});
