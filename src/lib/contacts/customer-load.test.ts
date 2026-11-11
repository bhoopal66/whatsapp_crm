import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  PAGE,
  loadCustomer,
  readPage,
  readShares,
  splitConversations,
  startCustomerLoad,
} from './customer-load';

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
        'neq',
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
    conversationExtra?: Record<string, unknown>;
  }) {
    const { sb, settle } = fakeClient();
    const out = loadCustomer(sb, 'c1');
    await flush();
    settle('contacts', { data: opts.contactRow ?? contact });
    settle('conversations', {
      data: opts.conversation
        ? [{ id: 'v1', assigned_agent_id: 'a1', ...opts.conversationExtra }]
        : [],
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

  it('returns the Smart insights figures beside the conversation', async () => {
    const l = await settledLoad({
      conversation: true,
      messages: { data: [] },
      conversationExtra: {
        insight_intent: 'business_loan',
        insight_intent_p: 0.82,
        insight_lead_temp: 1.6,
        insight_upset: 0.1,
        insight_at: '2026-10-29T08:00:00Z',
        insight_sentiment: 2.8,
        insight_objections: ['price'],
        insight_attention_at: '2026-10-29T08:01:00Z',
        insight_attention_reason: 'callback',
        unread_count: 2,
      },
    });
    if (l.state !== 'ready') throw new Error(l.state);
    expect(l.insights).toEqual({
      id: 'v1',
      insight_intent: 'business_loan',
      insight_intent_p: 0.82,
      insight_urgency: null,
      insight_lead_temp: 1.6,
      insight_upset: 0.1,
      insight_wants_human: null,
      insight_at: '2026-10-29T08:00:00Z',
      insight_sentiment: 2.8,
      insight_objections: ['price'],
      insight_needs_reply: null,
      insight_callback: null,
      insight_attention_at: '2026-10-29T08:01:00Z',
      insight_attention_reason: 'callback',
      unread_count: 2,
    });
  });

  it('has no insights without a conversation', async () => {
    const l = await settledLoad({ conversation: false, messages: {} });
    if (l.state !== 'ready') throw new Error(l.state);
    expect(l.insights).toBeNull();
  });

  it('selects the insight columns with the conversation id', async () => {
    const { sb, issued } = fakeClient();
    void loadCustomer(sb, 'c1');
    await flush();
    const conv = issued.find((q) => q.table === 'conversations');
    expect(JSON.stringify(conv?.ops)).toContain('insight_lead_temp');
    expect(JSON.stringify(conv?.ops)).toContain('insight_at');
    for (const col of [
      'insight_sentiment',
      'insight_objections',
      'insight_attention_at',
      'insight_attention_reason',
      'unread_count',
    ])
      expect(JSON.stringify(conv?.ops)).toContain(col);
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

describe('startCustomerLoad', () => {
  it('reads the conversations once, oldest first, for the basics and the thread', async () => {
    const { sb, issued, settle } = fakeClient();
    const parts = startCustomerLoad(sb, 'c1');
    await flush();
    const convs = issued.filter((q) => q.table === 'conversations');
    expect(convs).toHaveLength(1);
    expect(convs[0].ops).toContainEqual([
      'order',
      ['created_at', { ascending: true }],
    ]);
    const select = String(convs[0].ops[0][1][0]);
    for (const col of ['channel_id', 'send_channel_id', 'chat_tag_id'])
      expect(select).toContain(col);
    settle('conversations', {
      data: [
        {
          id: 'v1',
          contact_id: 'c1',
          assigned_agent_id: 'a1',
          channel_id: 'n1',
          send_channel_id: 'n2',
          chat_tag_id: 't1',
          chat_sub_tag_id: null,
        },
      ],
    });
    await flush();
    // Wave 2: the page of messages, then the last message (no failures).
    const msgs = issued.filter((q) => q.table === 'messages');
    expect(msgs).toHaveLength(2);
    expect(msgs[1].ops).toContainEqual(['neq', ['status', 'failed']]);
    msgs[1].settle({
      data: { sender_type: 'customer', created_at: '2026-10-29T10:00:00Z' },
    });
    await expect(parts.thread).resolves.toEqual({
      pin: 'n2',
      home: 'n1',
      last: { at: '2026-10-29T10:00:00Z', byCustomer: true },
      chatTags: { chat_tag_id: 't1', chat_sub_tag_id: null },
    });
  });

  it('shows the basics before the timeline answers', async () => {
    const { sb, settle } = fakeClient();
    const parts = startCustomerLoad(sb, 'c1');
    await flush();
    settle('contacts', { data: contact });
    settle('conversations', { data: [] });
    settle('deals', { data: [] });
    settle('pbx_settings', { data: null });
    // contact_notes and the calls are still unanswered.
    const basics = await parts.basics;
    expect(basics?.contact).toEqual(contact);
    expect(basics?.conversation).toBeNull();
  });

  it('answers null basics for a missing contact', async () => {
    const { sb, settle } = fakeClient();
    const parts = startCustomerLoad(sb, 'c1');
    await flush();
    settle('contacts', { data: null });
    settle('conversations', { data: [] });
    settle('deals', { data: [] });
    settle('pbx_settings', { data: null });
    await expect(parts.basics).resolves.toBeNull();
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

describe('splitConversations', () => {
  const row = (id: string, owner: string | null = null) => ({
    id,
    assigned_agent_id: null,
    personal_owner_id: owner,
  });

  it('takes the oldest company chat as the conversation, past an older personal one', () => {
    const { company, personal } = splitConversations([
      row('p1', 'u9'),
      row('c1'),
      row('c2'),
      row('p2', 'u8'),
    ]);
    expect(company.map((r) => r.id)).toEqual(['c1', 'c2']);
    expect(personal).toEqual([
      { id: 'p1', ownerId: 'u9' },
      { id: 'p2', ownerId: 'u8' },
    ]);
  });

  it('has no company chat when only personal ones are visible', () => {
    expect(splitConversations([row('p1', 'u9')]).company).toEqual([]);
  });
});

describe('startCustomerLoad with personal chats', () => {
  it('keeps the thread and basics on the company chat', async () => {
    const { sb, issued, settle } = fakeClient();
    const parts = startCustomerLoad(sb, 'c1');
    await flush();
    const select = String(
      issued.find((q) => q.table === 'conversations')?.ops[0][1][0]
    );
    expect(select).toContain('personal_owner_id');
    settle('contacts', { data: contact });
    settle('deals', { data: [] });
    settle('pbx_settings', { data: null });
    settle('conversations', {
      data: [
        {
          id: 'p1',
          contact_id: 'c1',
          assigned_agent_id: 'u9',
          personal_owner_id: 'u9',
          channel_id: 'pn',
          send_channel_id: null,
          chat_tag_id: null,
          chat_sub_tag_id: null,
        },
        {
          id: 'v1',
          contact_id: 'c1',
          assigned_agent_id: 'a1',
          personal_owner_id: null,
          channel_id: 'n1',
          send_channel_id: null,
          chat_tag_id: null,
          chat_sub_tag_id: null,
        },
      ],
    });
    const basics = await parts.basics;
    expect(basics?.conversation).toEqual({ id: 'v1', assignedTo: 'a1' });
    expect(basics?.personalChats).toEqual([{ id: 'p1', ownerId: 'u9' }]);
    await flush();
    const msgs = issued.filter((q) => q.table === 'messages');
    msgs[msgs.length - 1].settle({ data: null });
    await expect(parts.thread).resolves.toMatchObject({ home: 'n1' });
  });
});
