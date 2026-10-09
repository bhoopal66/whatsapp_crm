import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  dispatch: vi.fn(),
  afterCallbacks: [] as (() => Promise<void> | void)[],
  admin: null as unknown,
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (cb: () => Promise<void> | void) => {
      mocks.afterCallbacks.push(cb);
    },
  };
});

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(() => ({ success: true })),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { send: { limit: 60, windowMs: 60_000 } },
}));

vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: mocks.dispatch,
}));

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => mocks.admin,
}));

import { POST } from './route';

type Result = { data: unknown; error: unknown };

/**
 * A chainable stand-in for a supabase-js client: every builder method
 * records its call and returns the builder; `maybeSingle()` and an
 * awaited builder resolve to the next result queued for that table.
 */
function fakeClient(results: Record<string, Result[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  const client = {
    calls,
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const take = () =>
        Promise.resolve(
          (results[table] ?? []).shift() ?? { data: null, error: null }
        );
      for (const method of ['select', 'update', 'eq', 'order', 'limit']) {
        builder[method] = (...args: unknown[]) => {
          calls.push({ table, method, args });
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
const CONV_ROW = { id: CONV, contact_id: 'contact-1', channel_id: 'chan-conv' };

let scoped: ReturnType<typeof fakeClient>;
let admin: ReturnType<typeof fakeClient>;

function setup(opts: {
  conv?: unknown;
  lastMessage?: unknown;
  channel?: unknown;
}) {
  scoped = fakeClient({
    conversations: [
      { data: 'conv' in opts ? opts.conv : CONV_ROW, error: null },
      { data: null, error: null }, // the update
    ],
  });
  admin = fakeClient({
    messages: [{ data: opts.lastMessage ?? null, error: null }],
    whatsapp_config: [{ data: opts.channel ?? null, error: null }],
  });
  mocks.admin = admin;
  mocks.requireRole.mockResolvedValue({
    supabase: scoped,
    accountId: 'account-1',
    userId: 'user-1',
    role: 'agent',
  });
}

function post(body: unknown) {
  return POST(
    new Request(`http://localhost/api/ai/autoreply/${CONV}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ conversationId: CONV }) }
  );
}

function updatePatch(): Record<string, unknown> | undefined {
  const call = scoped.calls.find((c) => c.method === 'update');
  return call?.args[0] as Record<string, unknown> | undefined;
}

async function runAfter() {
  for (const cb of mocks.afterCallbacks.splice(0)) await cb();
}

const CUSTOMER_LAST = {
  sender_type: 'customer',
  content_text: 'Is my card ready?',
  message_id: 'wamid-1',
  channel_id: 'chan-msg',
  created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
};
const HOURS_AGO_25 = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.dispatch.mockReset().mockResolvedValue('replied');
  mocks.afterCallbacks.length = 0;
});

describe('POST /api/ai/autoreply/[conversationId]', () => {
  it('is 404 when the caller cannot see the chat, before any write', async () => {
    setup({ conv: null });
    const res = await post({ paused: false, reply_now: true });
    expect(res.status).toBe(404);
    expect(updatePatch()).toBeUndefined();
    expect(admin.calls).toHaveLength(0);
  });

  it('taking over records the take_over reason and time', async () => {
    setup({});
    const res = await post({ paused: true, assign_to_me: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      paused: true,
      replying: false,
    });
    const patch = updatePatch();
    expect(patch).toMatchObject({
      ai_autoreply_disabled: true,
      ai_paused_reason: 'take_over',
      assigned_agent_id: 'user-1',
    });
    expect(typeof patch?.ai_paused_at).toBe('string');
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it('resuming clears the pause, the held draft and the hand-off', async () => {
    setup({});
    const res = await post({ paused: false });
    expect(await res.json()).toEqual({
      success: true,
      paused: false,
      replying: false,
    });
    expect(updatePatch()).toEqual({
      ai_autoreply_disabled: false,
      assigned_agent_id: null,
      ai_reply_count: 0,
      ai_handoff_summary: null,
      ai_handoff_reason: null,
      ai_paused_reason: null,
      ai_paused_at: null,
      ai_pending_draft: null,
      ai_pending_draft_at: null,
      ai_attention_at: null,
    });
    // Without reply_now nothing is looked up or dispatched.
    expect(admin.calls).toHaveLength(0);
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it('taking over and resuming both clear the Important pin (078)', async () => {
    for (const paused of [true, false]) {
      setup({});
      await post({ paused });
      expect(updatePatch()).toHaveProperty('ai_attention_at', null);
    }
  });

  it('reply_now answers the customer’s last message on its own number, in after()', async () => {
    setup({
      lastMessage: CUSTOMER_LAST,
      channel: { provider: 'meta', user_id: 'owner-1' },
    });
    const res = await post({ paused: false, reply_now: true });
    expect(await res.json()).toEqual({
      success: true,
      paused: false,
      replying: true,
    });
    expect(
      admin.calls.find(
        (c) => c.table === 'whatsapp_config' && c.method === 'eq'
      )?.args
    ).toEqual(['id', 'chan-msg']);
    // Nothing is dispatched until the response is out.
    expect(mocks.dispatch).not.toHaveBeenCalled();
    await runAfter();
    expect(mocks.dispatch).toHaveBeenCalledWith({
      accountId: 'account-1',
      conversationId: CONV,
      contactId: 'contact-1',
      configOwnerUserId: 'owner-1',
      inboundProvider: 'meta',
      inboundChannelId: 'chan-msg',
      inboundMessageId: 'wamid-1',
      inboundText: 'Is my card ready?',
    });
  });

  it('reply_now skips a Meta message older than 24 hours, the resume still succeeds', async () => {
    setup({
      lastMessage: { ...CUSTOMER_LAST, created_at: HOURS_AGO_25 },
      channel: { provider: 'meta', user_id: 'owner-1' },
    });
    const res = await post({ paused: false, reply_now: true });
    expect(await res.json()).toEqual({
      success: true,
      paused: false,
      replying: false,
    });
    expect(updatePatch()).toMatchObject({ ai_autoreply_disabled: false });
    expect(mocks.afterCallbacks).toHaveLength(0);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('reply_now still answers an old Whapi message', async () => {
    setup({
      lastMessage: { ...CUSTOMER_LAST, created_at: HOURS_AGO_25 },
      channel: { provider: 'whapi', user_id: 'owner-2' },
    });
    const res = await post({ paused: false, reply_now: true });
    expect((await res.json()).replying).toBe(true);
  });

  it('reply_now falls back to the chat’s number when the message has none', async () => {
    setup({
      lastMessage: { ...CUSTOMER_LAST, channel_id: null },
      channel: { provider: 'whapi', user_id: 'owner-2' },
    });
    await post({ paused: false, reply_now: true });
    await runAfter();
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        inboundChannelId: 'chan-conv',
        inboundProvider: 'whapi',
        configOwnerUserId: 'owner-2',
      })
    );
  });

  it.each([
    [
      'the last message is the agent’s',
      { ...CUSTOMER_LAST, sender_type: 'agent' },
    ],
    ['the last message has no text', { ...CUSTOMER_LAST, content_text: '  ' }],
    ['the chat has no messages', null],
  ])('reply_now does nothing when %s', async (_label, lastMessage) => {
    setup({ lastMessage, channel: { provider: 'meta', user_id: 'owner-1' } });
    const res = await post({ paused: false, reply_now: true });
    expect((await res.json()).replying).toBe(false);
    expect(mocks.afterCallbacks).toHaveLength(0);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('reply_now is ignored when pausing', async () => {
    setup({ lastMessage: CUSTOMER_LAST });
    const res = await post({ paused: true, reply_now: true });
    expect((await res.json()).replying).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });
});
