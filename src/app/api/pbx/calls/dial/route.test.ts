import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  service: null as unknown,
  pbxApiFor: vi.fn(),
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Forbidden' }, { status: 403 })
  ),
}));
vi.mock('@/lib/pbx/admin', async (orig) => ({
  ...(await orig<typeof import('@/lib/pbx/admin')>()),
  pbxServiceDb: () => mocks.service,
}));
vi.mock('@/lib/pbx/connection', async (orig) => ({
  ...(await orig<typeof import('@/lib/pbx/connection')>()),
  pbxApiFor: mocks.pbxApiFor,
}));

import { POST } from './route';

const A = '00000000-0000-4000-8000-00000000000a';
const C1 = '00000000-0000-4000-8000-000000000001';
const C2 = '00000000-0000-4000-8000-000000000002';
const CONV = '00000000-0000-4000-8000-000000000003';
const contact = (id: string, phone: string, dnc: string | null = null) => ({
  id,
  account_id: A,
  phone,
  do_not_contact_at: dnc,
  do_not_contact_reason: dnc ? 'Asked on the phone' : null,
});
let rls: FakeDb;
let service: FakeDb;
const dial = vi.fn();

function as(role: string, visible = [contact(C1, '971501234567')]) {
  rls = createFakeDb(
    {
      contacts: visible,
      conversations: [{ id: CONV, contact_id: C1 }],
    },
    {
      pbx_my_extension: () => ({
        data: [
          {
            connection_id: 'conn-1',
            extension: '201',
            softphone_enabled: false,
          },
        ],
        error: null,
      }),
    }
  );
  mocks.requireRole.mockResolvedValue({
    accountId: A,
    userId: 'user-1',
    role,
    supabase: rls.db,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  service = createFakeDb({
    contacts: [contact(C1, '971501234567'), contact(C2, '971509999999', 'x')],
    pbx_audit: [],
  });
  mocks.service = service.db;
  dial.mockResolvedValue({ callId: 'pbx-77' });
  mocks.pbxApiFor.mockResolvedValue({ api: { dial } });
  as('agent');
});

const post = (body: unknown) =>
  POST(
    new Request('https://crm.example.com/api/pbx/calls/dial', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );

describe('POST /api/pbx/calls/dial', () => {
  it('needs an agent', async () => {
    mocks.requireRole.mockRejectedValue(new Error('no'));
    expect((await post({ contactId: C1 })).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
  });

  it('calls from the caller’s own extension only, whatever the body says', async () => {
    const res = await post({
      contactId: C1,
      extension: '999',
      caller: '999',
      from: '999',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pbxCallId: 'pbx-77' });
    expect(mocks.pbxApiFor).toHaveBeenCalledWith(service.db, 'conn-1');
    expect(dial).toHaveBeenCalledWith({
      caller: '201',
      callee: '971501234567',
    });
  });

  it('refuses a caller with no extension', async () => {
    rls.rpcs.pbx_my_extension = () => ({ data: [], error: null });
    const res = await post({ contactId: C1 });
    expect(res.status).toBe(409);
    expect(dial).not.toHaveBeenCalled();
  });

  it('resolves the customer of a conversation', async () => {
    expect((await post({ conversationId: CONV })).status).toBe(200);
    expect(dial).toHaveBeenCalledWith({
      caller: '201',
      callee: '971501234567',
    });
  });

  it('lets an agent type only a visible customer’s number', async () => {
    expect((await post({ number: '050 123 4567' })).status).toBe(200);
    expect((await post({ number: '+44 20 7946 0000' })).status).toBe(403);
    expect((await post({ number: '205' })).status).toBe(403);
    expect(dial).toHaveBeenCalledTimes(1);
    as('team_leader');
    expect((await post({ number: '+44 20 7946 0000' })).status).toBe(200);
  });

  it('refuses a do-not-contact customer, even one the caller cannot see', async () => {
    as('agent', [contact(C2, '971509999999', 'x')]);
    let res = await post({ contactId: C2 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'do_not_contact',
      reason: 'Asked on the phone',
    });
    as('team_leader', []);
    res = await post({ number: '0509999999', overrideReason: 'please' });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBeNull();
    expect(dial).not.toHaveBeenCalled();
    expect(service.tables.pbx_audit).toHaveLength(0);
  });

  it('lets an admin override with a reason, logged before dialling', async () => {
    as('admin', [contact(C2, '971509999999', 'x')]);
    dial.mockImplementation(async () => {
      expect(service.tables.pbx_audit).toHaveLength(1);
      return { callId: 'pbx-78' };
    });
    const res = await post({
      contactId: C2,
      overrideReason: ' Customer rang back ',
    });
    expect(res.status).toBe(200);
    expect(service.tables.pbx_audit[0]).toMatchObject({
      account_id: A,
      actor_id: 'user-1',
      action: 'dnc_override_call',
      contact_id: C2,
      reason: 'Customer rang back',
    });
    expect(dial).toHaveBeenCalledWith({
      caller: '201',
      callee: '971509999999',
    });
  });

  describe('a deal-room participant', () => {
    const B = '00000000-0000-4000-8000-00000000000b';
    const R = '00000000-0000-4000-8000-0000000000a1';
    const P = '00000000-0000-4000-8000-0000000000b1';
    const BANK = '00000000-0000-4000-8000-0000000000b2';
    const OTHER = '00000000-0000-4000-8000-0000000000b3';
    const person = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      room_id: R,
      account_id: A,
      role: 'customer',
      status: 'joined',
      bank_code: null,
      phone: '971501112222',
      wa_id: '971501112222',
      contact_id: null,
      ...over,
    });
    let canPost: unknown[];

    beforeEach(() => {
      service.tables.deal_rooms = [{ id: R, account_id: A, status: 'open' }];
      service.tables.deal_room_participants = [
        person(P),
        person(BANK, {
          role: 'bank_guest',
          bank_code: 'ADCB',
          phone: '971502223333',
        }),
        person(OTHER, { account_id: B }),
      ];
      service.tables.bank_guest_policies = [
        { account_id: A, bank_code: 'ADCB', guests_allowed: false },
      ];
      canPost = [];
      rls.rpcs.deal_room_can_post = (args) => {
        canPost.push(args);
        return { data: true, error: null };
      };
    });

    it('dials the number the server holds, from the caller’s own extension', async () => {
      const res = await post({ participantId: P, extension: '999' });
      expect(res.status).toBe(200);
      expect(canPost).toEqual([{ p_room: R }]);
      expect(dial).toHaveBeenCalledWith({
        caller: '201',
        callee: '971501112222',
      });
    });

    it('refuses someone who cannot post in the room, and another workspace’s participant', async () => {
      rls.rpcs.deal_room_can_post = () => ({ data: false, error: null });
      const res = await post({ participantId: P });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('forbidden');
      rls.rpcs.deal_room_can_post = () => ({ data: true, error: null });
      const other = await post({ participantId: OTHER });
      expect(other.status).toBe(404);
      expect(dial).not.toHaveBeenCalled();
    });

    it('calls a bank officer only while the bank’s guests are on', async () => {
      const res = await post({ participantId: BANK });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('bank_guests_off');
      expect(dial).not.toHaveBeenCalled();
      service.tables.bank_guest_policies[0].guests_allowed = true;
      expect((await post({ participantId: BANK })).status).toBe(200);
      expect(dial).toHaveBeenCalledWith({
        caller: '201',
        callee: '971502223333',
      });
    });

    it('refuses a do-not-contact number, never naming the hidden reason', async () => {
      service.tables.deal_room_participants[0].phone = '971509999999';
      const res = await post({ participantId: P });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'do_not_contact',
        reason: null,
      });
      service.tables.deal_room_participants[0].phone = '971501112222';
      service.tables.deal_room_participants[0].contact_id = C2;
      expect((await post({ participantId: P })).status).toBe(409);
      expect(dial).not.toHaveBeenCalled();
    });

    it('refuses someone removed, a closed room, and a mixed body', async () => {
      service.tables.deal_room_participants[0].status = 'removed';
      expect((await post({ participantId: P })).status).toBe(409);
      service.tables.deal_room_participants[0].status = 'joined';
      service.tables.deal_rooms[0].status = 'closed';
      expect((await post({ participantId: P })).status).toBe(409);
      expect((await post({ participantId: P, contactId: C1 })).status).toBe(
        400
      );
      expect(dial).not.toHaveBeenCalled();
    });
  });
});
