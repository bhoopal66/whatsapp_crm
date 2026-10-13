import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  createFakeDb,
  type FakeDb,
  type Result,
  type Row,
} from '@/lib/pbx/__tests__/fake-db';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Forbidden' }, { status: 403 })
  ),
}));

import { POST } from './route';

const CONN = '00000000-0000-4000-8000-0000000000c1';
const CALL = '00000000-0000-4000-8000-000000000001';
const OTHER_CALL = '00000000-0000-4000-8000-000000000002';
const NEW = '00000000-0000-4000-8000-000000000003';
const MATCHED = '00000000-0000-4000-8000-000000000004';
const CONV = '00000000-0000-4000-8000-000000000005';
let rls: FakeDb;
let link: Mock<(args: Row) => Result>;

beforeEach(() => {
  vi.clearAllMocks();
  // As pbx_link_call_contact: a call the caller sees, and below team
  // leader only their own.
  link = vi.fn((args: Row) => {
    const call = rls.tables.calls.find((c) => c.id === args.p_call_id);
    if (!call)
      return {
        data: null,
        error: { code: 'P0002', message: 'Call not found' },
      };
    if (call.user_id !== 'u')
      return {
        data: null,
        error: {
          code: '42501',
          message:
            'Only the person on the call or a team leader can re-link it',
        },
      };
    Object.assign(call, {
      contact_id: args.p_contact_id,
      conversation_id: CONV,
      deal_id: null,
    });
    return { data: null, error: null };
  });
  // The caller's own reads (RLS): the calls they can see.
  rls = createFakeDb(
    {
      calls: [
        // Declined while the form was open: ended, matched to no one.
        {
          id: CALL,
          account_id: 'a',
          connection_id: CONN,
          pbx_call_id: 'px-1',
          status: 'missed',
          user_id: 'u',
          contact_id: null,
          conversation_id: null,
          deal_id: null,
        },
        // The same PBX ids seen in another workspace (an older row).
        {
          id: OTHER_CALL,
          account_id: 'b',
          connection_id: CONN,
          pbx_call_id: 'px-1',
          status: 'missed',
          user_id: 'u',
          contact_id: null,
          conversation_id: null,
          deal_id: null,
        },
      ],
    },
    { pbx_link_call_contact: link }
  );
  mocks.requireRole.mockResolvedValue({
    accountId: 'a',
    userId: 'u',
    role: 'agent',
    supabase: rls.db,
  });
});

const post = (body: unknown) =>
  POST(
    new Request('https://crm.example.com/api/pbx/calls/link', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
const asked = { connectionId: CONN, pbxCallId: 'px-1', contactId: NEW };

describe('POST /api/pbx/calls/link', () => {
  it('needs an agent', async () => {
    mocks.requireRole.mockRejectedValue(new Error('no'));
    expect((await post(asked)).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
  });

  it('links a call that ended while the form was open, by its PBX ids', async () => {
    const res = await post(asked);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      linked: true,
      callId: CALL,
      contactId: NEW,
      conversationId: CONV,
      dealId: null,
    });
    expect(link).toHaveBeenCalledTimes(1);
    expect(link).toHaveBeenCalledWith({ p_call_id: CALL, p_contact_id: NEW });
    expect(rls.tables.calls[1].contact_id).toBeNull();
  });

  it('keeps a match made meanwhile, and leaves calls it cannot see', async () => {
    rls.tables.calls[0].contact_id = MATCHED;
    let res = await post(asked);
    expect(await res.json()).toEqual({ linked: false });
    expect(rls.tables.calls[0].contact_id).toBe(MATCHED);
    // No row the caller sees: not yet written, or not theirs to see.
    res = await post({ ...asked, pbxCallId: 'px-2' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: false });
    expect(link).not.toHaveBeenCalled();
  });

  it('maps a refusal of the link', async () => {
    rls.tables.calls[0].user_id = 'someone else';
    const res = await post(asked);
    expect(res.status).toBe(403);
    expect(rls.tables.calls[0].contact_id).toBeNull();
  });

  it('validates the ids', async () => {
    expect((await post({ ...asked, connectionId: 'x' })).status).toBe(404);
    expect((await post({ ...asked, pbxCallId: ' ' })).status).toBe(404);
    expect((await post({ ...asked, pbxCallId: 'p'.repeat(129) })).status).toBe(
      404
    );
    expect((await post({ ...asked, contactId: 'x' })).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    expect(link).not.toHaveBeenCalled();
  });
});
