import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { chatAssistHandlers, ChatAssistActionError } from './handlers';

const USER = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const CHAT = '44444444-4444-4444-8444-444444444444';
const OTHER = '66666666-6666-4666-8666-666666666666';

/** A caller's client that records what each table was asked to do. */
function fakeRls(answers: Record<string, unknown> = {}) {
  const calls: { table: string; op: string; arg?: unknown }[] = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    const chain = (op: string) => (arg?: unknown) => {
      calls.push({ table, op, arg });
      return b;
    };
    for (const op of ['select', 'eq', 'is', 'order', 'limit', 'update'])
      b[op] = chain(op);
    b.insert = chain('insert');
    b.maybeSingle = async () => ({
      data: answers[`${table}.maybeSingle`] ?? null,
      error: null,
    });
    b.single = async () => ({
      data: answers[`${table}.single`] ?? null,
      error: null,
    });
    b.then = (res: (v: unknown) => unknown) =>
      res({ data: answers[`${table}.list`] ?? [], error: null });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient, calls };
}

const scope = (rls: SupabaseClient) => ({
  rls,
  accountId: ACCOUNT,
  userId: USER,
  conversationId: CHAT,
  defer: vi.fn(),
});

describe('chat assistant handlers', () => {
  it('refuse arguments naming another chat, writing nothing', async () => {
    const { db, calls } = fakeRls();
    const h = chatAssistHandlers(scope(db));
    await expect(
      h.chat_add_note({ conversationId: OTHER, body: 'x' }, {} as never)
    ).rejects.toBeInstanceOf(ChatAssistActionError);
    await expect(
      h.chat_assign(
        { conversationId: CHAT, expected: null, userId: 'me' },
        {} as never
      )
    ).rejects.toThrow('bad_args');
    expect(calls).toEqual([]);
  });

  it('a note goes to conversation_notes on the caller’s client, never messages', async () => {
    const { db, calls } = fakeRls({
      'conversation_notes.single': { id: 'n1' },
    });
    const h = chatAssistHandlers(scope(db));
    expect(
      await h.chat_add_note(
        { conversationId: CHAT, body: 'Wants a POS' },
        {} as never
      )
    ).toEqual({ noteId: 'n1' });
    expect(calls[0]).toEqual({
      table: 'conversation_notes',
      op: 'insert',
      arg: { conversation_id: CHAT, body: 'Wants a POS', mention_ids: [] },
    });
    expect(calls.some((c) => c.table === 'messages')).toBe(false);
  });

  it('a task is the caller’s own follow-up from the chat', async () => {
    const { db, calls } = fakeRls({
      'conversations.maybeSingle': { contact_id: 'c1' },
      'tasks.single': { id: 't1' },
    });
    const h = chatAssistHandlers(scope(db));
    await h.chat_create_task(
      { conversationId: CHAT, title: 'Call back', dueAt: null },
      {} as never
    );
    const insert = calls.find((c) => c.table === 'tasks' && c.op === 'insert');
    expect(insert?.arg).toMatchObject({
      title: 'Call back',
      kind: 'follow_up',
      source: 'chat',
      conversation_id: CHAT,
      contact_id: 'c1',
      assigned_to: USER,
      created_by: USER,
      account_id: ACCOUNT,
    });
  });

  it('reads the chat capped, newest first from the database', async () => {
    const { db, calls } = fakeRls({ 'messages.list': [] });
    const h = chatAssistHandlers(scope(db));
    expect(await h.chat_read({ conversationId: CHAT }, {} as never)).toEqual(
      []
    );
    expect(calls).toContainEqual({ table: 'messages', op: 'limit', arg: 60 });
  });
});
