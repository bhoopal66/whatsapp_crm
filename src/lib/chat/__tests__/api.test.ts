import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import * as api from '../api';
import { ChatError, toChatError } from '../errors';

type Result = { data: unknown; error: unknown };

/** Records rpc calls and query-builder chains; answers from `results` in call order. */
function fakeSb(...results: Result[]) {
  const calls: { op: string; args: unknown[] }[][] = [];
  const next = () => results.shift() ?? { data: [], error: null };
  const builder = (chain: { op: string; args: unknown[] }[]) => {
    const b: Record<string, unknown> = {
      then: (res: (r: Result) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(next()).then(res, rej),
    };
    for (const op of [
      'select',
      'eq',
      'is',
      'in',
      'or',
      'order',
      'limit',
      'range',
    ])
      b[op] = (...args: unknown[]) => (chain.push({ op, args }), b);
    return b;
  };
  const sb = {
    rpc: (fn: string, args?: unknown) => {
      calls.push([{ op: 'rpc', args: args === undefined ? [fn] : [fn, args] }]);
      return Promise.resolve(next());
    },
    from: (table: string) => {
      const chain = [{ op: 'from', args: [table] as unknown[] }];
      calls.push(chain);
      return builder(chain);
    },
  };
  return { sb: sb as unknown as SupabaseClient, calls };
}

const ok = (data: unknown): Result => ({ data, error: null });
const CH = 'c0000000-0000-4000-8000-000000000001';
const M = 'e0000000-0000-4000-8000-00000000000e';

describe('RPC wrappers', () => {
  it('pass the 087 parameter names and defaults', async () => {
    const { sb, calls } = fakeSb(
      ok('new-id'),
      ok('dm-id'),
      ok('msg-id'),
      ok(null),
      ok(null),
      ok(true),
      ok(3)
    );
    expect(
      await api.createChannel(sb, {
        accountId: 'ws',
        kind: 'team',
        name: 'ops',
      })
    ).toBe('new-id');
    expect(await api.openDm(sb, { accountId: 'ws', memberIds: ['u2'] })).toBe(
      'dm-id'
    );
    expect(await api.postMessage(sb, { channelId: CH, body: 'hi' })).toBe(
      'msg-id'
    );
    await api.markRead(sb, CH);
    await api.markRead(sb, CH, '2026-10-12T08:00:00Z');
    expect(await api.toggleReaction(sb, M, '👍')).toBe(true);
    expect(await api.addMembers(sb, CH, ['u3'])).toBe(3);
    expect(calls.map((c) => c[0].args)).toEqual([
      [
        'chat_create_channel',
        {
          p_ws: 'ws',
          p_kind: 'team',
          p_name: 'ops',
          p_topic: null,
          p_member_ids: [],
        },
      ],
      ['chat_open_dm', { p_ws: 'ws', p_member_ids: ['u2'] }],
      [
        'chat_post_message',
        {
          p_channel: CH,
          p_body: 'hi',
          p_thread_root: null,
          p_share_conversation: null,
          p_attachments: [],
        },
      ],
      ['chat_mark_read', { p_channel: CH }],
      ['chat_mark_read', { p_channel: CH, p_at: '2026-10-12T08:00:00Z' }],
      ['chat_toggle_reaction', { p_message: M, p_emoji: '👍' }],
      ['chat_add_members', { p_channel: CH, p_user_ids: ['u3'] }],
    ]);
  });

  it('map rows to camelCase types', async () => {
    const { sb } = fakeSb(
      ok([{ channel_id: CH, unread: 2, mentions: 1 }]),
      ok([
        {
          message_id: M,
          conversation_id: 'cv',
          snapshot: {
            contact_name: 'Sara',
            phone: '+971 XXXXXXX12',
            chat_tag: { name: 'Hot', color: 'red' },
            last_messages: [
              { sender_type: 'customer', content_text: 'hi', created_at: 't' },
            ],
          },
          can_open: false,
          chat_tag: null,
          status: null,
          last_message_at: null,
        },
      ]),
      ok(null)
    );
    expect(await api.unreadCounts(sb, 'ws')).toEqual([
      { channelId: CH, unread: 2, mentions: 1, muted: false },
    ]);
    const [card] = await api.sharedCards(sb, [M]);
    expect(card).toMatchObject({
      canOpen: false,
      chatTag: null,
      snapshot: {
        contactName: 'Sara',
        chatTag: { name: 'Hot', color: 'red' },
        lastMessages: [{ senderType: 'customer', contentText: 'hi' }],
      },
    });
    expect(await api.deleteMessage(sb, M)).toEqual([]);
  });

  it('share a call through chat_share_call and read its card (103)', async () => {
    const { sb, calls } = fakeSb(
      ok('card-msg'),
      ok([
        {
          message_id: M,
          can_open: true,
          erased: false,
          call_id: 'c1',
          direction: 'outbound',
          status: 'answered',
          started_at: '2026-10-02T09:00:00Z',
          talk_seconds: 61,
          outcome: 'call_back',
          notes: 'later',
          agent_name: 'Rana',
          contact_id: 'k1',
          contact_name: 'Sara',
          phone: '+971 XXXXXXX01',
        },
      ])
    );
    expect(
      await api.shareCall(sb, { channelId: CH, callId: 'c1', body: 'fyi' })
    ).toBe('card-msg');
    const [card] = await api.sharedCallCards(sb, [M]);
    expect(calls.map((c) => c[0].args)).toEqual([
      ['chat_share_call', { p_channel: CH, p_call: 'c1', p_body: 'fyi' }],
      ['chat_shared_call_cards', { p_message_ids: [M] }],
    ]);
    expect(card).toMatchObject({
      messageId: M,
      canOpen: true,
      erased: false,
      direction: 'outbound',
      talkSeconds: 61,
      contactName: 'Sara',
    });
    expect(await api.sharedCallCards(sb, [])).toEqual([]);
  });

  it('skip the round trip for an empty id list', async () => {
    const { sb, calls } = fakeSb();
    expect(await api.sharedCards(sb, [])).toEqual([]);
    expect(await api.reactionsFor(sb, [])).toEqual({});
    expect(calls).toEqual([]);
  });

  it('throw ChatError with the mapped code and key', async () => {
    const { sb } = fakeSb({
      data: null,
      error: { code: '42501', message: 'chat: channel is archived' },
    });
    const err = await api
      .postMessage(sb, { channelId: CH, body: 'x' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ChatError);
    expect(err).toMatchObject({
      code: 'FORBIDDEN',
      key: 'archived',
      sqlState: '42501',
    });
  });
});

describe('table reads', () => {
  it('listMessages: top-level newest page, oldest first, with hasMore and a compound cursor', async () => {
    const row = (id: string, min: number) => ({
      id,
      channel_id: CH,
      account_id: 'ws',
      thread_root_id: null,
      author_kind: 'user',
      author_id: 'u',
      body: id,
      meta: {},
      created_at: `2026-10-12T08:0${min}:00+00:00`,
    });
    const { sb, calls } = fakeSb(
      ok([row('m3', 3), row('m2', 2), row('m1', 1)])
    );
    const page = await api.listMessages(sb, CH, {
      limit: 2,
      before: { createdAt: '2026-10-12T08:09:00.5+00:00', id: M },
    });
    expect(page.messages.map((m) => m.id)).toEqual(['m2', 'm3']);
    expect(page.hasMore).toBe(true);
    expect(calls[0]).toEqual([
      { op: 'from', args: ['internal_messages'] },
      { op: 'select', args: [api.MESSAGE_COLUMNS] },
      { op: 'eq', args: ['channel_id', CH] },
      { op: 'is', args: ['thread_root_id', null] },
      {
        op: 'or',
        args: [
          `created_at.lt."2026-10-12T08:09:00.5+00:00",and(created_at.eq."2026-10-12T08:09:00.5+00:00",id.lt.${M})`,
        ],
      },
      { op: 'order', args: ['created_at', { ascending: false }] },
      { op: 'order', args: ['id', { ascending: false }] },
      { op: 'limit', args: [3] },
    ]);
    await expect(
      api.listMessages(sb, CH, { before: { createdAt: 'x",id.gt.0', id: M } })
    ).rejects.toThrow(TypeError);
  });

  it('listMessages for a thread filters on its root', async () => {
    const { sb, calls } = fakeSb(ok([]));
    expect(await api.listMessages(sb, CH, { threadRootId: M })).toEqual({
      messages: [],
      hasMore: false,
    });
    expect(calls[0]).toContainEqual({ op: 'eq', args: ['thread_root_id', M] });
  });

  it('listChannels embeds only the caller’s membership and skips archived', async () => {
    const { sb, calls } = fakeSb(
      ok([
        {
          id: CH,
          account_id: 'ws',
          kind: 'dm',
          name: null,
          dm_key: 'u1,u2',
          created_by: 'u1',
          created_at: 't',
          me: [
            {
              channel_id: CH,
              user_id: 'u1',
              role: 'member',
              joined_at: 't',
              muted: false,
            },
          ],
        },
        {
          id: 'team',
          account_id: 'ws',
          kind: 'team',
          name: 'ops',
          dm_key: null,
          created_by: 'u2',
          created_at: 't',
          me: [],
        },
      ])
    );
    const list = await api.listChannels(sb, 'ws', 'u1');
    expect(
      list.map((c) => [c.kind, c.dmMemberIds, c.membership?.role ?? null])
    ).toEqual([
      ['dm', ['u1', 'u2'], 'member'],
      ['team', [], null],
    ]);
    expect(calls[0]).toContainEqual({ op: 'eq', args: ['me.user_id', 'u1'] });
    expect(calls[0]).toContainEqual({ op: 'is', args: ['archived_at', null] });
  });

  it('threadSummaries / reactionsFor / attachmentsFor group by message', async () => {
    const { sb } = fakeSb(
      ok([
        {
          id: 'r1',
          thread_root_id: 'a',
          author_id: 'u1',
          created_at: '2026-10-12T08:01:00Z',
        },
        {
          id: 'r2',
          thread_root_id: 'a',
          author_id: 'u2',
          created_at: '2026-10-12T08:02:00Z',
        },
        {
          id: 'r3',
          thread_root_id: 'a',
          author_id: 'u1',
          created_at: '2026-10-12T08:03:00Z',
        },
      ]),
      ok([
        { message_id: 'a', user_id: 'u1', emoji: '👍' },
        { message_id: 'a', user_id: 'u2', emoji: '🎉' },
        { message_id: 'a', user_id: 'u2', emoji: '👍' },
      ]),
      ok([
        {
          id: 'f',
          message_id: 'a',
          storage_path: 'p',
          name: 'n.pdf',
          mime: 'application/pdf',
          bytes: '42',
        },
      ])
    );
    expect((await api.threadSummaries(sb, ['a', 'b'])).a).toMatchObject({
      replyCount: 3,
      lastReplyAt: '2026-10-12T08:03:00Z',
      authorIds: ['u1', 'u2'],
    });
    expect((await api.reactionsFor(sb, ['a'])).a).toEqual([
      { emoji: '👍', count: 2, userIds: ['u1', 'u2'] },
      { emoji: '🎉', count: 1, userIds: ['u2'] },
    ]);
    expect((await api.attachmentsFor(sb, ['a'])).a).toEqual([
      {
        id: 'f',
        messageId: 'a',
        storagePath: 'p',
        name: 'n.pdf',
        mime: 'application/pdf',
        bytes: 42,
      },
    ]);
  });
});

describe('toChatError', () => {
  it.each([
    [
      'CH001',
      'chat: internal chat is disabled for this workspace',
      'DISABLED',
      'disabled',
    ],
    [
      'P0002',
      'chat_post_message: attachment x was not uploaded',
      'NOT_FOUND',
      'attachmentMissing',
    ],
    ['P0002', 'chat_set_pin: message not found', 'NOT_FOUND', 'notFound'],
    [
      '22023',
      'chat_open_dm: a DM has 2 to 8 members (got 9)',
      'INVALID',
      'dmSize',
    ],
    [
      '22023',
      'chat_leave_channel: the last admin of a private channel cannot leave',
      'INVALID',
      'lastAdmin',
    ],
    [
      '23514',
      'chat_set_pin: a channel can have at most 100 pins',
      'INVALID',
      'pinLimit',
    ],
    [
      '23514',
      'new row violates check constraint "internal_messages_body_len"',
      'INVALID',
      'bodyLength',
    ],
    [
      '23505',
      'duplicate key value violates unique constraint "chat_channels_name_uq"',
      'CONFLICT',
      'duplicateName',
    ],
    ['40001', 'could not serialize access', 'CONFLICT', 'conflict'],
    [
      '42501',
      'chat: not a member of this channel',
      'FORBIDDEN',
      'notChannelMember',
    ],
    [
      '42501',
      'chat_edit_message: only the author can edit',
      'FORBIDDEN',
      'notAuthor',
    ],
    [
      '42501',
      'permission denied for function chat_erase_person',
      'FORBIDDEN',
      'forbidden',
    ],
    ['PGRST202', 'Could not find the function', 'UNKNOWN', 'unknown'],
  ])('%s %s → %s/%s', (code, message, expCode, expKey) => {
    const e = toChatError({ code, message });
    expect([e.code, e.key, e.message]).toEqual([expCode, expKey, message]);
  });

  it('wraps code-less failures and passes a ChatError through', () => {
    const e = toChatError(new TypeError('fetch failed'));
    expect([e.code, e.key, e.sqlState]).toEqual([
      'UNKNOWN',
      'unknown',
      undefined,
    ]);
    expect(toChatError(e)).toBe(e);
  });
});

describe('savedIdsIn', () => {
  it('reads the caller’s saved rows of one channel through the message', async () => {
    const { sb, calls } = fakeSb(
      ok([{ message_id: M, message: { channel_id: CH } }])
    );
    await expect(api.savedIdsIn(sb, CH)).resolves.toEqual([M]);
    expect(calls[0]).toEqual([
      { op: 'from', args: ['saved_messages'] },
      {
        op: 'select',
        args: ['message_id, message:internal_messages!inner(channel_id)'],
      },
      { op: 'eq', args: ['message.channel_id', CH] },
    ]);
  });

  it('throws a ChatError', async () => {
    const { sb } = fakeSb({
      data: null,
      error: { code: '42501', message: 'x' },
    });
    await expect(api.savedIdsIn(sb, CH)).rejects.toBeInstanceOf(ChatError);
  });
});
