// The panel's calls through 019a's guarded router. The real AssistGuard,
// ConfirmationGate and LoopGuard run on lib/assist's fake supabase client;
// only the rate limiter is a stub. The point: a WRITE tool's handler never
// runs without the person's confirmation, a READ runs directly, and a
// tool the panel does not register is never run.
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { ToolHandler } from '@/lib/assist/router';
import type { RateLimiter } from '@/lib/assist/rate';
import {
  FakeDb,
  NONCE,
  PENDING,
  requestOk,
  type Answer,
} from '@/lib/assist/test-fakes';

import type { PlannedAction } from './actions';
import {
  chatAssistContext,
  createChatAssistRouter,
  holdActions,
  runConfirmed,
} from './router';
import { CHAT_ASSIST_WRITE_TOOLS, type ChatAssistTool } from './tools';

const USER = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const CHAT = '44444444-4444-4444-8444-444444444444';
const TAG = '55555555-5555-4555-8555-555555555555';

const noteArgs = { conversationId: CHAT, body: 'Customer wants a call back' };
const tagArgs = { conversationId: CHAT, tagId: TAG, subTagId: null };

function setup(script: Record<string, Answer | Answer[]> = {}) {
  const db = new FakeDb(script);
  const handlers = Object.fromEntries(
    (['chat_read', ...CHAT_ASSIST_WRITE_TOOLS] as ChatAssistTool[]).map((t) => [
      t,
      vi.fn<ToolHandler>(async () => ({ ran: t })),
    ])
  ) as Record<ChatAssistTool, ReturnType<typeof vi.fn<ToolHandler>>>;
  const rate = {
    check: async () => ({ allowed: true }),
  } as unknown as RateLimiter;
  const assist = createChatAssistRouter(
    db as unknown as SupabaseClient,
    handlers,
    { rate }
  );
  const ctx = chatAssistContext({
    userId: USER,
    accountId: ACCOUNT,
    runId: 'run-1',
  });
  const anyWriteRan = () =>
    CHAT_ASSIST_WRITE_TOOLS.some((t) => handlers[t].mock.calls.length > 0);
  return { db, handlers, assist, ctx, anyWriteRan };
}

const planned = (tool: PlannedAction['tool'], args: unknown): PlannedAction =>
  ({ tool, args, view: { kind: 'note', body: 'x' }, why: '' }) as PlannedAction;

describe('chat assist router: no WRITE without the person', () => {
  it('runs every call supervised', () => {
    expect(chatAssistContext({ userId: USER, accountId: ACCOUNT }).mode).toBe(
      'supervised'
    );
  });

  it('holds a suggested WRITE as a pending action and runs nothing', async () => {
    const { db, assist, ctx, anyWriteRan } = setup({
      assist_pending_request: requestOk(),
    });
    const cards = await holdActions(assist, ctx, [
      planned('chat_add_note', noteArgs),
    ]);
    expect(anyWriteRan()).toBe(false);
    expect(db.rpcCalls('assist_pending_request')).toHaveLength(1);
    expect(db.rpcCalls('assist_pending_request')[0]).toMatchObject({
      p_tool: 'chat_add_note',
      p_args: noteArgs,
    });
    expect(cards).toEqual([
      expect.objectContaining({
        status: 'pending',
        pendingId: PENDING,
        nonce: NONCE,
        tool: 'chat_add_note',
      }),
    ]);
  });

  it.each(CHAT_ASSIST_WRITE_TOOLS)(
    '%s called with no pending id is held, never run',
    async (tool) => {
      const { assist, ctx, anyWriteRan } = setup({
        assist_pending_request: requestOk(),
      });
      const r = await assist.router.execute(ctx, { tool, args: { x: 1 } });
      expect(r).toEqual({ status: 'needs_confirmation', pendingId: PENDING });
      expect(anyWriteRan()).toBe(false);
    }
  );

  it('arguments that "approve" themselves approve nothing', async () => {
    const { assist, ctx, anyWriteRan } = setup({
      assist_pending_request: requestOk(),
    });
    const r = await assist.router.execute(ctx, {
      tool: 'chat_add_note',
      args: { ...noteArgs, confirm: true, approved: 'yes' },
    });
    expect(r.status).toBe('needs_confirmation');
    expect(anyWriteRan()).toBe(false);
  });

  it('refuses to run a pending action the person has not confirmed', async () => {
    const { db, assist, ctx, anyWriteRan } = setup({
      assist_pending_consume: { data: false },
    });
    db.pendingRow = {
      id: PENDING,
      user_id: USER,
      account_id: ACCOUNT,
      status: 'pending',
      action_hash: 'h',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const r = await runConfirmed(assist, ctx, {
      tool: 'chat_add_note',
      args: noteArgs,
      pendingId: PENDING,
    });
    expect(r).toEqual({ status: 'denied', reason: 'NOT_CONFIRMED' });
    expect(anyWriteRan()).toBe(false);
  });

  it("refuses another person's or another workspace's confirmation", async () => {
    const { db, assist, ctx, anyWriteRan } = setup({
      assist_pending_consume: { data: false },
    });
    db.pendingRow = {
      id: PENDING,
      user_id: '99999999-9999-4999-8999-999999999999',
      account_id: ACCOUNT,
      status: 'confirmed',
      action_hash: 'h',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const r = await runConfirmed(assist, ctx, {
      tool: 'chat_set_tag',
      args: tagArgs,
      pendingId: PENDING,
    });
    expect(r).toEqual({ status: 'denied', reason: 'WRONG_USER' });
    expect(anyWriteRan()).toBe(false);
  });

  it('refuses a confirmed action whose arguments were changed', async () => {
    const { db, assist, ctx, anyWriteRan } = setup({
      assist_pending_consume: { data: false },
    });
    db.pendingRow = {
      id: PENDING,
      user_id: USER,
      account_id: ACCOUNT,
      status: 'confirmed',
      action_hash: 'the hash of what was confirmed',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const r = await runConfirmed(assist, ctx, {
      tool: 'chat_add_note',
      args: { ...noteArgs, body: 'something else' },
      pendingId: PENDING,
    });
    expect(r).toEqual({ status: 'denied', reason: 'HASH_MISMATCH' });
    expect(anyWriteRan()).toBe(false);
  });

  it('runs a confirmed action once, with exactly its arguments', async () => {
    const { db, handlers, assist, ctx } = setup({
      assist_pending_consume: { data: true },
    });
    const r = await runConfirmed(assist, ctx, {
      tool: 'chat_add_note',
      args: noteArgs,
      pendingId: PENDING,
    });
    expect(r).toEqual({ status: 'ok', result: { ran: 'chat_add_note' } });
    expect(handlers.chat_add_note).toHaveBeenCalledTimes(1);
    expect(handlers.chat_add_note.mock.calls[0]?.[0]).toEqual(noteArgs);
    expect(db.rpcCalls('assist_pending_consume')[0]).toMatchObject({
      p_id: PENDING,
      p_user: USER,
      p_account: ACCOUNT,
    });
  });

  it('a READ runs directly, with no pending action', async () => {
    const { db, handlers, assist, ctx } = setup();
    const r = await assist.router.execute(ctx, {
      tool: 'chat_read',
      args: { conversationId: CHAT },
    });
    expect(r.status).toBe('ok');
    expect(handlers.chat_read).toHaveBeenCalledTimes(1);
    expect(db.rpcCalls('assist_pending_request')).toEqual([]);
  });

  it('a tool the panel does not register never runs', async () => {
    const { assist, ctx, anyWriteRan } = setup();
    for (const tool of ['send_message', 'bulk_send', 'delete_contact']) {
      const r = await assist.router.execute(ctx, { tool, args: {} });
      expect(r).toEqual({ status: 'denied', reason: 'UNKNOWN_TOOL' });
    }
    expect(anyWriteRan()).toBe(false);
  });

  it('a held action the guard refuses becomes an unavailable card', async () => {
    const { assist, ctx, anyWriteRan } = setup({
      assist_pending_request: { data: [] }, // the open-pending cap
    });
    const cards = await holdActions(assist, ctx, [
      planned('chat_set_tag', tagArgs),
    ]);
    expect(cards).toEqual([
      expect.objectContaining({ status: 'unavailable', reason: 'PENDING_CAP' }),
    ]);
    expect(anyWriteRan()).toBe(false);
  });

  it('will not hold or run anything outside the supervised mode', async () => {
    const { assist, anyWriteRan } = setup({
      assist_pending_consume: { data: true },
    });
    const loose = {
      runId: 'r',
      userId: USER,
      workspaceId: ACCOUNT,
      mode: 'autonomous' as const,
    };
    await expect(
      holdActions(assist, loose, [planned('chat_add_note', noteArgs)])
    ).rejects.toThrow(/supervised/);
    expect(() =>
      runConfirmed(assist, loose, {
        tool: 'chat_add_note',
        args: noteArgs,
        pendingId: PENDING,
      })
    ).toThrow(/supervised/);
    expect(anyWriteRan()).toBe(false);
  });
});
