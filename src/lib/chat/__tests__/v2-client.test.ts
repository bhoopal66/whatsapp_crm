import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import * as api from '../api';
import { ChatError } from '../errors';
import { subscribeChat } from '../realtime';
import {
  toAttachment,
  toChatMessage,
  toTypingRow,
  type ChatAttachment,
} from '../types';

type Result = { data: unknown; error: unknown };
const ok = (data: unknown): Result => ({ data, error: null });

const WS = 'aaaaaaaa-0000-4000-8000-000000000001';
const SRC = 'bbbbbbbb-0000-4000-8000-000000000002';
const DST = 'cccccccc-0000-4000-8000-000000000003';
const MSG = 'eeeeeeee-0000-4000-8000-00000000000e';

function fakeSb(results: Result[], copyError: unknown = null) {
  const rpcs: { fn: string; args: unknown }[] = [];
  const copies: { from: string; to: string }[] = [];
  const chains: { op: string; args: unknown[] }[][] = [];
  const next = () => results.shift() ?? ok([]);
  const sb = {
    rpc: (fn: string, args?: unknown) => {
      rpcs.push({ fn, args });
      return Promise.resolve(next());
    },
    from: (table: string) => {
      const chain = [{ op: 'from', args: [table] as unknown[] }];
      chains.push(chain);
      const b: Record<string, unknown> = {
        then: (res: (r: Result) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(next()).then(res, rej),
      };
      for (const op of ['select', 'eq', 'in', 'order'])
        b[op] = (...args: unknown[]) => (chain.push({ op, args }), b);
      return b;
    },
    storage: {
      from: (bucket: string) => ({
        copy: async (from: string, to: string) => {
          expect(bucket).toBe('chat-files');
          copies.push({ from, to });
          return { data: null, error: copyError };
        },
      }),
    },
  };
  return { sb: sb as unknown as SupabaseClient, rpcs, copies, chains };
}

const att = (over: Partial<ChatAttachment> = {}): ChatAttachment => ({
  id: 'a1',
  messageId: MSG,
  storagePath: `account-${WS}/channel-${SRC}/x-note.ogg`,
  name: 'note.ogg',
  mime: 'audio/ogg',
  bytes: 10,
  kind: 'voice',
  durationMs: 4200,
  ...over,
});

describe('types', () => {
  it('toAttachment reads kind and duration, unknown kind is file', () => {
    expect(
      toAttachment({ id: 'a', kind: 'voice', duration_ms: 900 })
    ).toMatchObject({
      kind: 'voice',
      durationMs: 900,
    });
    expect(toAttachment({ id: 'a', kind: 'weird' })).toMatchObject({
      kind: 'file',
      durationMs: null,
    });
    expect(toAttachment({ id: 'a' }).kind).toBe('file');
  });

  it('toChatMessage maps reply_to_id and meta.forwarded', () => {
    const m = toChatMessage({
      id: MSG,
      reply_to_id: 'q1',
      meta: {
        forwarded: {
          message_id: 'm0',
          author_id: 'u1',
          author_kind: 'user',
          created_at: '2026-10-30T00:00:00Z',
        },
      },
    });
    expect(m.replyToId).toBe('q1');
    expect(m.forwarded).toEqual({
      messageId: 'm0',
      authorId: 'u1',
      authorKind: 'user',
      createdAt: '2026-10-30T00:00:00Z',
    });
  });

  it('forwarded is null unless message_id and created_at are strings', () => {
    expect(toChatMessage({ id: 'x' }).forwarded).toBeNull();
    expect(toChatMessage({ id: 'x' }).replyToId).toBeNull();
    expect(
      toChatMessage({ id: 'x', meta: { forwarded: { message_id: 'm' } } })
        .forwarded
    ).toBeNull();
    expect(
      toChatMessage({
        id: 'x',
        meta: {
          forwarded: {
            message_id: 'm',
            created_at: 't',
            author_kind: 'system',
          },
        },
      }).forwarded
    ).toEqual({
      messageId: 'm',
      authorId: null,
      authorKind: 'system',
      createdAt: 't',
    });
  });
});

describe('postMessage reply', () => {
  it('sends p_reply_to only when set', async () => {
    const { sb, rpcs } = fakeSb([ok('1'), ok('2'), ok('3')]);
    await api.postMessage(sb, { channelId: SRC, body: 'a' });
    await api.postMessage(sb, { channelId: SRC, body: 'b', replyToId: null });
    await api.postMessage(sb, { channelId: SRC, body: 'c', replyToId: 'q1' });
    expect('p_reply_to' in (rpcs[0].args as object)).toBe(false);
    expect('p_reply_to' in (rpcs[1].args as object)).toBe(false);
    expect(rpcs[2].args).toMatchObject({ p_reply_to: 'q1' });
  });

  it('passes voice attachment fields through', async () => {
    const { sb, rpcs } = fakeSb([ok('1')]);
    const a = {
      storage_path: 'p',
      name: 'n',
      mime: 'audio/ogg',
      bytes: 1,
      kind: 'voice' as const,
      duration_ms: 1500,
    };
    await api.postMessage(sb, { channelId: SRC, body: '', attachments: [a] });
    expect(rpcs[0].args).toMatchObject({ p_attachments: [a] });
  });
});

describe('forwardMessage', () => {
  it('copies into the target prefix then makes one rpc with the copies', async () => {
    const { sb, rpcs, copies } = fakeSb([ok('new-id')]);
    const out = await api.forwardMessage(sb, {
      accountId: WS,
      messageId: MSG,
      targetChannelId: DST,
      attachments: [
        att(),
        att({
          id: 'a2',
          name: 'r.pdf',
          mime: 'application/pdf',
          kind: 'file',
          durationMs: null,
        }),
      ],
    });
    expect(out).toBe('new-id');
    expect(copies).toHaveLength(2);
    for (const c of copies) {
      expect(c.from).toContain(`channel-${SRC}`);
      expect(c.to.startsWith(`account-${WS}/channel-${DST}/`)).toBe(true);
    }
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0].fn).toBe('chat_forward_message');
    const args = rpcs[0].args as {
      p_message: string;
      p_channel: string;
      p_attachments: Record<string, unknown>[];
    };
    expect(args.p_message).toBe(MSG);
    expect(args.p_channel).toBe(DST);
    expect(args.p_attachments[0]).toEqual({
      storage_path: copies[0].to,
      name: 'note.ogg',
      mime: 'audio/ogg',
      bytes: 10,
      kind: 'voice',
      duration_ms: 4200,
    });
    expect('duration_ms' in args.p_attachments[1]).toBe(false);
    expect(args.p_attachments[1].kind).toBe('file');
  });

  it('a failed copy throws a ChatError and makes no rpc', async () => {
    const { sb, rpcs } = fakeSb([ok('x')], {
      message: 'new row violates row-level security',
      statusCode: '403',
    });
    await expect(
      api.forwardMessage(sb, {
        accountId: WS,
        messageId: MSG,
        targetChannelId: DST,
        attachments: [att()],
      })
    ).rejects.toBeInstanceOf(ChatError);
    expect(rpcs).toHaveLength(0);
  });
});

describe('156 wrappers', () => {
  it('setTyping and markVoicePlayed pass the parameter names', async () => {
    const { sb, rpcs } = fakeSb([ok(null), ok(null), ok(null)]);
    await api.setTyping(sb, { channelId: SRC, typing: true });
    await api.setTyping(sb, {
      channelId: SRC,
      threadRootId: 't',
      typing: false,
    });
    await api.markVoicePlayed(sb, MSG);
    expect(rpcs.map((r) => [r.fn, r.args])).toEqual([
      [
        'chat_set_typing',
        { p_channel: SRC, p_thread_root: null, p_typing: true },
      ],
      [
        'chat_set_typing',
        { p_channel: SRC, p_thread_root: 't', p_typing: false },
      ],
      ['chat_mark_voice_played', { p_message: MSG }],
    ]);
  });

  it('voicePlaysFor groups by message and skips the request when empty', async () => {
    const { sb, chains } = fakeSb([
      ok([
        { message_id: 'm1', user_id: 'u1', played_at: 't1' },
        { message_id: 'm1', user_id: 'u2', played_at: 't2' },
      ]),
    ]);
    expect(await api.voicePlaysFor(sb, [])).toEqual({});
    expect(chains).toHaveLength(0);
    const out = await api.voicePlaysFor(sb, ['m1']);
    expect(out.m1.map((p) => p.userId)).toEqual(['u1', 'u2']);
  });

  it('typingIn maps rows', async () => {
    const { sb } = fakeSb([
      ok([
        {
          channel_id: SRC,
          account_id: WS,
          user_id: 'u',
          thread_root_id: null,
          at: 't',
        },
      ]),
    ]);
    expect(await api.typingIn(sb, SRC)).toEqual([
      toTypingRow({
        channel_id: SRC,
        account_id: WS,
        user_id: 'u',
        at: 't',
      }),
    ]);
  });

  it('messagesByIds fills attachments and short-circuits on no ids', async () => {
    const { sb, chains } = fakeSb([
      ok([{ id: 'm1', channel_id: SRC, reply_to_id: null }]),
      ok([{ id: 'a', message_id: 'm1', kind: 'voice', duration_ms: 5 }]),
    ]);
    expect(await api.messagesByIds(sb, [])).toEqual([]);
    expect(chains).toHaveLength(0);
    const out = await api.messagesByIds(sb, ['m1']);
    expect(out[0].attachments[0].kind).toBe('voice');
  });

  it('channelFiles asks for limit+1 and reports hasMore', async () => {
    const row = (i: number) => ({
      id: `a${i}`,
      message_id: `m${i}`,
      storage_path: 'p',
      name: 'n',
      mime: 'm',
      bytes: 1,
      kind: 'file',
      created_at: 't',
      author_id: null,
    });
    const { sb, rpcs } = fakeSb([
      ok([row(1), row(2), row(3)]),
      ok([row(1), row(2)]),
    ]);
    const a = await api.channelFiles(sb, {
      channelId: SRC,
      kind: 'voice',
      limit: 2,
    });
    expect(rpcs[0].args).toEqual({
      p_channel: SRC,
      p_kind: 'voice',
      p_before: null,
      p_limit: 3,
    });
    expect(a.items).toHaveLength(2);
    expect(a.hasMore).toBe(true);
    expect(a.items[0].createdAt).toBe('t');
    const b = await api.channelFiles(sb, { channelId: SRC, limit: 2 });
    expect(b.hasMore).toBe(false);
  });
});

describe('subscribeChat 156 tables', () => {
  it('routes typing and voice-play events', () => {
    const handlers: Record<string, (p: unknown) => void> = {};
    const ch: Record<string, unknown> = {
      on: (_t: string, f: { table: string }, fn: (p: unknown) => void) => {
        handlers[f.table] = fn;
        return ch;
      },
      subscribe: () => ch,
    };
    const sb = {
      channel: () => ch,
      removeChannel: () => {},
    } as unknown as SupabaseClient;
    const typing: unknown[] = [];
    const plays: unknown[] = [];
    subscribeChat(sb, {
      accountId: WS,
      userId: 'u',
      onTyping: (e) => typing.push(e),
      onVoicePlay: (p) => plays.push(p),
    });
    handlers.chat_typing({
      eventType: 'DELETE',
      old: { channel_id: SRC, user_id: 'u9' },
      new: {},
    });
    handlers.chat_typing({
      eventType: 'INSERT',
      new: { channel_id: SRC, account_id: WS, user_id: 'u9', at: 't' },
      old: {},
    });
    handlers.chat_voice_plays({
      eventType: 'UPDATE',
      new: { message_id: 'm' },
      old: {},
    });
    handlers.chat_voice_plays({
      eventType: 'INSERT',
      new: { message_id: 'm', user_id: 'u9', played_at: 't' },
      old: {},
    });
    expect(typing).toEqual([
      { type: 'delete', row: { channelId: SRC, userId: 'u9' } },
      {
        type: 'insert',
        row: expect.objectContaining({ userId: 'u9', threadRootId: null }),
      },
    ]);
    expect(plays).toEqual([{ messageId: 'm', userId: 'u9', playedAt: 't' }]);
  });
});
