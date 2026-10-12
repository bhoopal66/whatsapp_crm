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

const CALL = '00000000-0000-4000-8000-000000000001';
const SEEN = '00000000-0000-4000-8000-000000000002';
const UNSEEN = '00000000-0000-4000-8000-000000000003';
const CONV = '00000000-0000-4000-8000-000000000004';
let rls: FakeDb;
let link: Mock<(args: Row) => Result>;

beforeEach(() => {
  vi.clearAllMocks();
  // As pbx_link_call_contact: only a contact the caller can see.
  link = vi.fn((args: Row) => {
    const call = rls.tables.calls.find((c) => c.id === args.p_call_id);
    if (!call)
      return {
        data: null,
        error: { code: 'P0002', message: 'Call not found' },
      };
    if (call.erased_at)
      return {
        data: null,
        error: { code: '55000', message: 'This call was erased' },
      };
    if (args.p_contact_id !== SEEN)
      return {
        data: null,
        error: { code: 'P0002', message: 'Contact not found' },
      };
    Object.assign(call, {
      contact_id: SEEN,
      conversation_id: CONV,
      deal_id: null,
    });
    return { data: null, error: null };
  });
  rls = createFakeDb(
    {
      calls: [
        {
          id: CALL,
          contact_id: null,
          conversation_id: null,
          deal_id: null,
          erased_at: null,
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

const post = (body: unknown, id = CALL) =>
  POST(
    new Request(`https://crm.example.com/api/pbx/calls/${id}/link`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );

describe('POST /api/pbx/calls/[callId]/link', () => {
  it('needs an agent', async () => {
    mocks.requireRole.mockRejectedValue(new Error('no'));
    expect((await post({ contactId: SEEN })).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
  });

  it('links a visible contact, the chat following it', async () => {
    const res = await post({ contactId: SEEN });
    expect(res.status).toBe(200);
    expect(link).toHaveBeenCalledWith({ p_call_id: CALL, p_contact_id: SEEN });
    expect(await res.json()).toEqual({
      contactId: SEEN,
      conversationId: CONV,
      dealId: null,
    });
  });

  it('is refused for a contact the caller cannot see', async () => {
    const res = await post({ contactId: UNSEEN });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Contact not found' });
    expect(rls.tables.calls[0].contact_id).toBeNull();
  });

  it('validates and maps the other refusals', async () => {
    expect((await post({ contactId: 'x' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ contactId: SEEN }, 'nope')).status).toBe(404);
    expect(link).not.toHaveBeenCalled();
    rls.tables.calls[0].erased_at = '2026-10-11T00:00:00Z';
    expect((await post({ contactId: SEEN })).status).toBe(409);
  });
});
