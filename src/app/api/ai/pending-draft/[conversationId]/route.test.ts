import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  send: vi.fn(),
  rateLimitOk: true,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(() => ({ success: mocks.rateLimitOk })),
  rateLimitResponse: vi.fn(() =>
    Response.json({ error: 'slow down' }, { status: 429 })
  ),
  RATE_LIMITS: { send: { limit: 60, windowMs: 60_000 } },
}));

vi.mock('@/lib/whatsapp/send-message', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/whatsapp/send-message')>();
  return { ...actual, sendMessageToConversation: mocks.send };
});

import { SendMessageError } from '@/lib/whatsapp/send-message';
import { POST } from './route';

type Result = { data: unknown; error: unknown };

/** Chainable supabase-js stand-in; see the autoreply route test. */
function fakeClient(results: Result[]) {
  const calls: { method: string; args: unknown[] }[] = [];
  const client = {
    calls,
    from(table: string) {
      calls.push({ method: 'from', args: [table] });
      const builder: Record<string, unknown> = {};
      const take = () =>
        Promise.resolve(results.shift() ?? { data: null, error: null });
      for (const method of ['select', 'update', 'eq', 'is']) {
        builder[method] = (...args: unknown[]) => {
          calls.push({ method, args });
          return builder;
        };
      }
      builder.maybeSingle = () => take();
      builder.then = (
        resolve: (r: Result) => unknown,
        reject: (e: unknown) => unknown
      ) => take().then(resolve, reject);
      return builder;
    },
  };
  return client;
}

const CONV = 'conv-1';
const DRAFT_AT = '2026-10-09T06:00:00.000Z';
const HELD = {
  id: CONV,
  ai_pending_draft: 'Your card ships tomorrow.',
  ai_pending_draft_at: DRAFT_AT,
};

let scoped: ReturnType<typeof fakeClient>;

function setup(
  conv: unknown,
  clearResult: Result = { data: [{ id: CONV }], error: null }
) {
  scoped = fakeClient([{ data: conv, error: null }, clearResult]);
  mocks.requireRole.mockResolvedValue({
    supabase: scoped,
    accountId: 'account-1',
    userId: 'agent-1',
    role: 'agent',
  });
}

function post(body: unknown) {
  return POST(
    new Request(`http://localhost/api/ai/pending-draft/${CONV}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ conversationId: CONV }) }
  );
}

const updates = () => scoped.calls.filter((c) => c.method === 'update');

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.send.mockReset().mockResolvedValue({
    messageId: 'msg-1',
    whatsappMessageId: 'wamid-out',
  });
  mocks.rateLimitOk = true;
});

describe('POST /api/ai/pending-draft/[conversationId]', () => {
  it('requires an agent', async () => {
    mocks.requireRole.mockRejectedValue(new Error('viewer'));
    const res = await post({ action: 'discard' });
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(res.status).toBe(403);
  });

  it('is rate limited on the send bucket', async () => {
    setup(HELD);
    mocks.rateLimitOk = false;
    const res = await post({ action: 'send' });
    expect(res.status).toBe(429);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown action', { action: 'approve' }],
    ['an empty edit', { action: 'send', text: '   ' }],
    ['a non-string edit', { action: 'send', text: 5 }],
  ])('is 400 on %s', async (_label, body) => {
    setup(HELD);
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('is 404 when the caller cannot see the chat', async () => {
    setup(null);
    const res = await post({ action: 'send' });
    expect(res.status).toBe(404);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
  });

  it('is 409 when no draft is held', async () => {
    setup({ ...HELD, ai_pending_draft: null, ai_pending_draft_at: null });
    const res = await post({ action: 'discard' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toEqual(expect.any(String));
    expect(updates()).toHaveLength(0);
  });

  it('discard clears the draft it read, and sends nothing', async () => {
    setup(HELD);
    const res = await post({ action: 'discard' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      action: 'discard',
      cleared: true,
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(updates()).toEqual([
      {
        method: 'update',
        args: [{ ai_pending_draft: null, ai_pending_draft_at: null }],
      },
    ]);
    expect(scoped.calls).toContainEqual({
      method: 'eq',
      args: ['ai_pending_draft_at', DRAFT_AT],
    });
  });

  it('send claims the draft before sending it', async () => {
    setup(HELD);
    const order: string[] = [];
    mocks.send.mockImplementation(async () => {
      order.push('send');
      return { messageId: 'msg-1', whatsappMessageId: 'wamid-out' };
    });
    const orig = scoped.from.bind(scoped);
    scoped.from = (table: string) => {
      const b = orig(table) as Record<string, (...a: unknown[]) => unknown>;
      const upd = b.update;
      b.update = (...args: unknown[]) => {
        order.push('update');
        return upd(...args);
      };
      return b as ReturnType<typeof orig>;
    };
    const res = await post({ action: 'send' });
    expect(res.status).toBe(200);
    expect(order).toEqual(['update', 'send']);
  });

  it('send sends the stored draft as the calling agent', async () => {
    setup(HELD);
    const res = await post({ action: 'send' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      action: 'send',
      cleared: true,
      message_id: 'msg-1',
      whatsapp_message_id: 'wamid-out',
    });
    expect(mocks.send).toHaveBeenCalledWith(scoped, 'account-1', {
      conversationId: CONV,
      messageType: 'text',
      contentText: 'Your card ships tomorrow.',
      senderUserId: 'agent-1',
    });
    expect(updates()).toHaveLength(1);
  });

  it('send uses the agent’s edited text, trimmed', async () => {
    setup(HELD);
    await post({ action: 'send', text: '  Your card ships on Monday.  ' });
    expect(mocks.send).toHaveBeenCalledWith(
      scoped,
      'account-1',
      expect.objectContaining({ contentText: 'Your card ships on Monday.' })
    );
  });

  it('a failed send restores the draft and answers the send error', async () => {
    setup(HELD);
    mocks.send.mockRejectedValue(
      new SendMessageError('whatsapp_error', 'WhatsApp refused it', 502, true)
    );
    const res = await post({ action: 'send' });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'WhatsApp refused it',
      code: 'whatsapp_error',
      retryable: true,
    });
    expect(updates()).toEqual([
      {
        method: 'update',
        args: [{ ai_pending_draft: null, ai_pending_draft_at: null }],
      },
      {
        method: 'update',
        args: [
          {
            ai_pending_draft: HELD.ai_pending_draft,
            ai_pending_draft_at: DRAFT_AT,
          },
        ],
      },
    ]);
    // Only where no newer draft has arrived.
    expect(scoped.calls).toContainEqual({
      method: 'is',
      args: ['ai_pending_draft', null],
    });
  });

  it('a lost claim is 409 and sends nothing', async () => {
    setup(HELD, { data: [], error: null });
    const res = await post({ action: 'send' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      'This draft was already sent or discarded.'
    );
    expect(mocks.send).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(1);
  });

  it('a lost claim on discard is 409 too', async () => {
    setup(HELD, { data: [], error: null });
    const res = await post({ action: 'discard' });
    expect(res.status).toBe(409);
  });
});
