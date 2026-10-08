import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  write: vi.fn(),
  dispatch: vi.fn(),
  afterCallbacks: [] as (() => Promise<void> | void)[],
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

vi.mock('@/lib/chat-tags/server', () => ({
  writeConversationChatTags: mocks.write,
}));

vi.mock('@/lib/automations/chat-tag-dispatch', () => ({
  dispatchChatTagSet: mocks.dispatch,
}));

import { PUT } from './route';

const CONV = '11111111-1111-4111-8111-111111111111';
const MAIN = '22222222-2222-4222-8222-222222222222';
const SUB = '33333333-3333-4333-8333-333333333333';

const auth = {
  supabase: { name: 'scoped-client' },
  accountId: 'account-1',
  userId: 'user-1',
  role: 'agent',
};

function put(body: unknown, id = CONV) {
  return PUT(
    new Request(`http://localhost/api/conversations/${id}/chat-tags`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function runAfter() {
  for (const cb of mocks.afterCallbacks.splice(0)) await cb();
}

beforeEach(() => {
  mocks.requireRole.mockReset().mockResolvedValue(auth);
  mocks.write.mockReset();
  mocks.dispatch.mockReset().mockResolvedValue(undefined);
  mocks.afterCallbacks.length = 0;
});

describe('PUT /api/conversations/[id]/chat-tags', () => {
  it.each([
    ['no body', 'not json'],
    ['missing fields', {}],
    ['a missing sub-tag field', { chat_tag_id: MAIN }],
    ['a non-uuid tag', { chat_tag_id: 'interested', chat_sub_tag_id: null }],
    ['a numeric sub-tag', { chat_tag_id: MAIN, chat_sub_tag_id: 7 }],
  ])('is 400 on %s, before any write', async (_label, body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('is 400 on a sub-tag without a main tag', async () => {
    const res = await put({ chat_tag_id: null, chat_sub_tag_id: SUB });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/sub-tag needs a main tag/);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('is 400 on a malformed chat id', async () => {
    const res = await put({ chat_tag_id: null, chat_sub_tag_id: null }, 'x');
    expect(res.status).toBe(400);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('requires an agent and answers the auth error otherwise', async () => {
    mocks.requireRole.mockRejectedValue(new Error('viewer'));
    const res = await put({ chat_tag_id: MAIN, chat_sub_tag_id: null });
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(res.status).toBe(403);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('is 404 when the chat is missing or RLS refuses the write', async () => {
    mocks.write.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await put({ chat_tag_id: MAIN, chat_sub_tag_id: null });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "Chat not found, or you can't change its tags.",
    });
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it('is 400 with a plain message when the database refuses the pair', async () => {
    mocks.write.mockResolvedValue({
      ok: false,
      reason: 'invalid',
      message: 'violates foreign key constraint "conversations_chat_tag_fkey"',
    });
    const res = await put({ chat_tag_id: MAIN, chat_sub_tag_id: SUB });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).not.toMatch(/constraint/);
  });

  it('is 500 on any other failure', async () => {
    mocks.write.mockResolvedValue({ ok: false, reason: 'error', message: 'x' });
    const res = await put({ chat_tag_id: MAIN, chat_sub_tag_id: null });
    expect(res.status).toBe(500);
  });

  it('writes with the caller client, answers the saved row and dispatches after the response', async () => {
    const previous = { chat_tag_id: null, chat_sub_tag_id: null };
    // The trigger kept the main tag and dropped nothing here.
    const saved = { chat_tag_id: MAIN, chat_sub_tag_id: SUB };
    mocks.write.mockResolvedValue({
      ok: true,
      conversationId: CONV,
      contactId: 'contact-1',
      previous,
      saved,
    });

    const res = await put({ chat_tag_id: MAIN, chat_sub_tag_id: SUB });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(saved);
    expect(mocks.write).toHaveBeenCalledWith(auth.supabase, {
      accountId: 'account-1',
      conversationId: CONV,
      next: { chat_tag_id: MAIN, chat_sub_tag_id: SUB },
    });
    // Scheduled, not run inline.
    expect(mocks.afterCallbacks).toHaveLength(1);
    expect(mocks.dispatch).not.toHaveBeenCalled();

    await runAfter();
    expect(mocks.dispatch).toHaveBeenCalledWith({
      accountId: 'account-1',
      contactId: 'contact-1',
      conversationId: CONV,
      previous,
      saved,
    });
  });

  it('awaits the dispatch inside after()', async () => {
    let finished = false;
    mocks.dispatch.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      finished = true;
    });
    mocks.write.mockResolvedValue({
      ok: true,
      conversationId: CONV,
      contactId: 'contact-1',
      previous: { chat_tag_id: null, chat_sub_tag_id: null },
      saved: { chat_tag_id: MAIN, chat_sub_tag_id: null },
    });

    await put({ chat_tag_id: MAIN, chat_sub_tag_id: null });
    await mocks.afterCallbacks[0]();
    expect(finished).toBe(true);
  });

  it('answers the saved row but dispatches nothing when nothing changed', async () => {
    const same = { chat_tag_id: MAIN, chat_sub_tag_id: null };
    mocks.write.mockResolvedValue({
      ok: true,
      conversationId: CONV,
      contactId: 'contact-1',
      previous: same,
      saved: same,
    });

    const res = await put({ chat_tag_id: MAIN, chat_sub_tag_id: null });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(same);
    expect(mocks.afterCallbacks).toHaveLength(0);
    await runAfter();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
