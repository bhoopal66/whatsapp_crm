import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { PAGE, loadCustomer, readPage, readShares } from './customer-load';

// A fake client: each query records its chain and, once executed
// (awaited), waits on a deferred the test settles by table name.
interface Query {
  table: string;
  ops: [string, unknown[]][];
  settle: (r: { data?: unknown; error?: { message: string } | null }) => void;
}

function fakeClient() {
  const issued: Query[] = [];
  const sb = {
    from(table: string) {
      const ops: [string, unknown[]][] = [];
      const builder: Record<string, unknown> = {};
      for (const m of [
        'select',
        'eq',
        'is',
        'in',
        'lt',
        'order',
        'limit',
        'maybeSingle',
      ])
        builder[m] = (...args: unknown[]) => {
          ops.push([m, args]);
          return builder;
        };
      builder.then = (
        ok: (v: unknown) => unknown,
        ko: (e: unknown) => unknown
      ) =>
        new Promise((resolve) => {
          issued.push({
            table,
            ops,
            settle: (r) => resolve({ data: null, error: null, ...r }),
          });
        }).then(ok, ko);
      return builder;
    },
  } as unknown as SupabaseClient;
  const settle = (table: string, r: Parameters<Query['settle']>[0]) => {
    const q = issued.find((i) => i.table === table);
    if (!q) throw new Error(`${table} was never issued`);
    q.settle(r);
  };
  return { sb, issued, settle };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let calls: { url: string; resolve: (body: unknown) => void }[];
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    (url: string) =>
      new Promise((resolve) =>
        calls.push({
          url,
          resolve: (body) => resolve({ ok: true, json: async () => body }),
        })
      )
  );
});
afterEach(() => vi.unstubAllGlobals());

const contact = { id: 'c1', name: 'Ana', user_id: 'u1' };

describe('loadCustomer', () => {
  it('issues every contact-keyed read before any of them answers', async () => {
    const { sb, issued } = fakeClient();
    void loadCustomer(sb, 'c1');
    await flush();
    expect(issued.map((q) => q.table).sort()).toEqual(
      [
        'contact_notes',
        'contacts',
        'conversations',
        'deals',
        'pbx_settings',
      ].sort()
    );
    expect(calls.map((c) => c.url)).toEqual([
      '/api/pbx/calls?contactId=c1&scope=all&limit=50',
    ]);
  });

  it('reads messages by conversation id, with the shares, in the second round', async () => {
    const { sb, issued, settle } = fakeClient();
    void loadCustomer(sb, 'c1');
    await flush();
    expect(issued.some((q) => q.table === 'shared_conversations')).toBe(false);
    expect(issued.some((q) => q.table === 'messages')).toBe(false);
    settle('conversations', { data: [{ id: 'v1', assigned_agent_id: null }] });
    await flush();
    // Both are in flight now, neither has resolved.
    const share = issued.find((q) => q.table === 'shared_conversations');
    const msgs = issued.find((q) => q.table === 'messages');
    expect(share?.ops).toContainEqual(['eq', ['conversation_id', 'v1']]);
    expect(msgs?.ops).toContainEqual(['eq', ['conversation_id', 'v1']]);
    expect(JSON.stringify(msgs?.ops)).not.toContain('conversations!inner');
    expect(JSON.stringify(msgs?.ops)).not.toContain('conversations.contact_id');
  });

  async function settledLoad(opts: {
    conversation: boolean;
    messages: { data?: unknown; error?: { message: string } };
    contactRow?: unknown;
  }) {
    const { sb, settle } = fakeClient();
    const out = loadCustomer(sb, 'c1');
    await flush();
    settle('contacts', { data: opts.contactRow ?? contact });
    settle('conversations', {
      data: opts.conversation ? [{ id: 'v1', assigned_agent_id: 'a1' }] : [],
    });
    settle('deals', { data: [] });
    settle('pbx_settings', { data: { missed_call_whatsapp_draft: true } });
    settle('contact_notes', { data: [] });
    calls[0].resolve({ calls: [] });
    await flush();
    if (opts.conversation) {
      settle('messages', opts.messages);
      settle('shared_conversations', { data: [] });
    }
    return out;
  }

  it('keeps the messages when the viewer has the conversation', async () => {
    const msg = {
      id: 'm1',
      sender_type: 'customer',
      sender_id: null,
      content_text: 'hi',
      content_type: 'text',
      created_at: '2026-10-01T00:00:00Z',
    };
    const l = await settledLoad({
      conversation: true,
      messages: { data: [msg] },
    });
    expect(l.state).toBe('ready');
    if (l.state !== 'ready') return;
    expect(l.rows.messages).toEqual([msg]);
    expect(l.conversation).toEqual({ id: 'v1', assignedTo: 'a1' });
    expect(l.draftOn).toBe(true);
    expect(l.paging.messages).toEqual({
      oldest: '2026-10-01T00:00:00Z',
      more: false,
    });
  });

  it('shows no messages, and issues no read, without a conversation', async () => {
    const l = await settledLoad({
      conversation: false,
      messages: { error: { message: 'boom' } },
    });
    expect(l.state).toBe('ready');
    if (l.state === 'ready') expect(l.rows.messages).toEqual([]);
  });

  it('fails on a messages error when there is a conversation', async () => {
    await expect(
      settledLoad({ conversation: true, messages: { error: { message: 'x' } } })
    ).rejects.toThrow('x');
  });

  it('answers missing before any timeline failure', async () => {
    const { sb, settle } = fakeClient();
    const out = loadCustomer(sb, 'c1');
    await flush();
    settle('contact_notes', { error: { message: 'notes down' } });
    settle('contacts', { data: null });
    settle('conversations', { data: [] });
    settle('deals', { data: [] });
    settle('pbx_settings', { data: null });
    await expect(out).resolves.toEqual({ state: 'missing' });
  });
});

describe('readPage', () => {
  it('reads messages by conversation id, newest first, one page', async () => {
    const { sb, issued, settle } = fakeClient();
    const out = readPage(sb, 'messages', 'c1', '2026-10-01T00:00:00Z', 'v1');
    await flush();
    settle('messages', { data: [] });
    await out;
    expect(issued[0].ops).toEqual([
      [
        'select',
        ['id, sender_type, sender_id, content_text, content_type, created_at'],
      ],
      ['eq', ['conversation_id', 'v1']],
      ['lt', ['created_at', '2026-10-01T00:00:00Z']],
      ['order', ['created_at', { ascending: false }]],
      ['limit', [PAGE]],
    ]);
  });

  it('reads no messages without a conversation id', async () => {
    const { sb, issued } = fakeClient();
    expect(await readPage(sb, 'messages', 'c1', null, null)).toEqual([]);
    expect(issued).toEqual([]);
  });
});

describe('readShares', () => {
  it('names the channel FK and drops posts in channels the viewer cannot see', async () => {
    const { sb, issued, settle } = fakeClient();
    const out = readShares(sb, 'v1');
    await flush();
    settle('shared_conversations', {
      data: [
        {
          message_id: 'p1',
          internal_messages: {
            id: 'p1',
            author_id: 'u2',
            body: 'look',
            created_at: '2026-10-02T00:00:00Z',
            chat_channels: { name: 'sales' },
          },
        },
        {
          message_id: 'p2',
          internal_messages: {
            id: 'p2',
            author_id: 'u3',
            body: 'hidden',
            created_at: '2026-10-03T00:00:00Z',
            chat_channels: null,
          },
        },
      ],
    });
    expect(await out).toEqual([
      {
        id: 'p1',
        channelName: 'sales',
        authorId: 'u2',
        body: 'look',
        createdAt: '2026-10-02T00:00:00Z',
      },
    ]);
    const select = String(issued[0].ops[0][1][0]);
    expect(select).toContain('internal_messages!inner(');
    expect(select).toContain(
      'chat_channels!internal_messages_channel_id_fkey(name)'
    );
    expect(issued[0].ops).toContainEqual([
      'is',
      ['internal_messages.deleted_at', null],
    ]);
    expect(issued[0].ops).toContainEqual([
      'is',
      ['internal_messages.erased_at', null],
    ]);
  });
});
