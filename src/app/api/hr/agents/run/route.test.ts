import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  runHrAgents: vi.fn(),
  rpc: vi.fn(),
  hrRow: { data: null as unknown, error: null as unknown },
  eqArgs: [] as unknown[],
  admin: { admin: true },
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: vi.fn((err: { status?: number }) =>
    Response.json({ error: 'auth' }, { status: err?.status ?? 500 })
  ),
}));
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => h.admin }));
vi.mock('@/lib/hr/agents/server', () => ({ runHrAgents: h.runHrAgents }));

import { POST } from './route';

const CONV = '11111111-1111-4111-8111-111111111111';

function userClient() {
  return {
    rpc: h.rpc,
    from: (table: string) => {
      expect(table).toBe('hr_conversations');
      const q = {
        select: () => q,
        eq: (...args: unknown[]) => {
          h.eqArgs.push(args);
          return q;
        },
        maybeSingle: async () => h.hrRow,
      };
      return q;
    },
  };
}

function req(body: unknown) {
  return new Request('http://x/api/hr/agents/run', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.eqArgs = [];
  h.requireRole.mockResolvedValue({
    supabase: userClient(),
    accountId: 'acc-1',
    userId: 'user-1',
    role: 'agent',
  });
  h.rpc.mockResolvedValue({
    data: { admin: false, recruiter: 'member', dept: null },
    error: null,
  });
  h.hrRow = { data: { conversation_id: CONV }, error: null };
  h.runHrAgents.mockResolvedValue({ outcome: 'drafted', draftId: 'd-1' });
});

describe('POST /api/hr/agents/run', () => {
  it('runs the agents for the caller and answers the draft', async () => {
    const res = await POST(
      req({ conversationId: CONV, slots: [' Mon 10:00 '] })
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      outcome: 'drafted',
      draftId: 'd-1',
    });
    expect(h.requireRole).toHaveBeenCalledWith('agent');
    expect(h.rpc).toHaveBeenCalledWith('hr_my_roles');
    expect(h.eqArgs).toEqual([['conversation_id', CONV]]);
    expect(h.runHrAgents).toHaveBeenCalledWith(h.admin, {
      accountId: 'acc-1',
      conversationId: CONV,
      actorUserId: 'user-1',
      slots: ['Mon 10:00'],
    });
  });

  it('lets an HR admin in without a recruiter team role', async () => {
    h.rpc.mockResolvedValue({
      data: { admin: true, recruiter: null, dept: null },
      error: null,
    });
    const res = await POST(req({ conversationId: CONV }));
    expect(res.status).toBe(200);
    expect(h.runHrAgents.mock.calls[0][1].slots).toBeUndefined();
  });

  it('answers 401 when there is no session', async () => {
    h.requireRole.mockRejectedValue(
      Object.assign(new Error('no'), { status: 401 })
    );
    const res = await POST(req({ conversationId: CONV }));
    expect(res.status).toBe(401);
    expect(h.runHrAgents).not.toHaveBeenCalled();
  });

  it('answers 403 forbidden without a recruiter role', async () => {
    h.rpc.mockResolvedValue({
      data: { admin: false, recruiter: null, dept: 'lead' },
      error: null,
    });
    const res = await POST(req({ conversationId: CONV }));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'forbidden' });
    expect(h.runHrAgents).not.toHaveBeenCalled();
  });

  it('answers 404 when RLS hides the chat', async () => {
    h.hrRow = { data: null, error: null };
    const res = await POST(req({ conversationId: CONV }));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'not_found' });
    expect(h.runHrAgents).not.toHaveBeenCalled();
  });

  it.each([
    [
      'six slots',
      { conversationId: CONV, slots: ['a', 'b', 'c', 'd', 'e', 'f'] },
    ],
    ['a blank slot', { conversationId: CONV, slots: ['  '] }],
    ['an 81-character slot', { conversationId: CONV, slots: ['x'.repeat(81)] }],
    ['a non-string slot', { conversationId: CONV, slots: [5] }],
    ['slots not an array', { conversationId: CONV, slots: 'Mon' }],
    ['a bad conversation id', { conversationId: 'nope' }],
  ])('answers 400 invalid on %s', async (_name, body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'invalid' });
    expect(h.runHrAgents).not.toHaveBeenCalled();
  });

  it('accepts five slots of 80 characters', async () => {
    const slots = Array.from({ length: 5 }, () => 'y'.repeat(80));
    const res = await POST(req({ conversationId: CONV, slots }));
    expect(res.status).toBe(200);
  });

  it.each([
    [
      { outcome: 'handoff', draftId: 'd-2' },
      200,
      { outcome: 'handoff', draftId: 'd-2' },
    ],
    [{ outcome: 'opted_out' }, 200, { outcome: 'opted_out' }],
    [{ outcome: 'off' }, 409, { error: 'agents_off' }],
    [{ outcome: 'no_ai' }, 409, { error: 'ai_off' }],
    [{ outcome: 'no_message' }, 409, { error: 'no_message' }],
    [{ outcome: 'closed' }, 409, { error: 'closed' }],
    [{ outcome: 'contact_opted_out' }, 409, { error: 'opted_out' }],
    [{ outcome: 'cap' }, 409, { error: 'cap' }],
    [{ outcome: 'refused', code: 'LIMIT' }, 409, { error: 'limit' }],
    [{ outcome: 'refused', code: 'OPTED_OUT' }, 409, { error: 'opted_out' }],
    [{ outcome: 'refused', code: 'CLOSED' }, 409, { error: 'closed' }],
    [{ outcome: 'not_tracked' }, 404, { error: 'not_found' }],
    [{ outcome: 'not_recruiter' }, 409, { error: 'not_recruiter' }],
    [{ outcome: 'error' }, 502, { error: 'failed' }],
  ])('maps %o to %i', async (result, status, json) => {
    h.runHrAgents.mockResolvedValue(result);
    const res = await POST(req({ conversationId: CONV }));
    expect(res.status).toBe(status);
    await expect(res.json()).resolves.toEqual(json);
  });
});
