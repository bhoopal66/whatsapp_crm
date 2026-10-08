import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveChatTagsWrite, writeConversationChatTags } from './server';

type Result = {
  data: unknown;
  error: { code?: string; message: string } | null;
};
type Call = [string, ...unknown[]];

/**
 * A chainable stand-in for the supabase query builder. Every builder
 * records its calls; `maybeSingle()` answers a SELECT from `read` and
 * an UPDATE from `write` — or, for a sequence, the nth SELECT from
 * `reads[n]` and the nth UPDATE from `writes[n]`.
 */
function fakeDb(opts: {
  read?: Result;
  write?: Result;
  reads?: Result[];
  writes?: Result[];
  throwOn?: 'read';
}) {
  const queries: Call[][] = [];
  let readCount = 0;
  let writeCount = 0;
  const db = {
    from(table: string) {
      const calls: Call[] = [['from', table]];
      queries.push(calls);
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'order', 'limit', 'update']) {
        builder[m] = (...a: unknown[]) => {
          calls.push([m, ...a]);
          return builder;
        };
      }
      builder.maybeSingle = async () => {
        calls.push(['maybeSingle']);
        const isWrite = calls.some(([m]) => m === 'update');
        if (!isWrite && opts.throwOn === 'read') throw new Error('network');
        const answer = isWrite
          ? (opts.writes?.[writeCount++] ?? opts.write)
          : (opts.reads?.[readCount++] ?? opts.read);
        return answer ?? { data: null, error: null };
      };
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient, queries };
}

const ROW = {
  id: 'conv-1',
  contact_id: 'contact-1',
  chat_tag_id: 'new',
  chat_sub_tag_id: null,
};
const NEXT = { chat_tag_id: 'interested', chat_sub_tag_id: 'adcb' };

describe('writeConversationChatTags', () => {
  it('reads by conversation id within the account, writes, and reports previous + saved', async () => {
    const { db, queries } = fakeDb({
      read: { data: ROW, error: null },
      write: {
        data: { ...ROW, chat_tag_id: 'interested', chat_sub_tag_id: 'adcb' },
        error: null,
      },
    });

    const res = await writeConversationChatTags(db, {
      accountId: 'acc-1',
      conversationId: 'conv-1',
      next: NEXT,
    });

    expect(res).toEqual({
      ok: true,
      conversationId: 'conv-1',
      contactId: 'contact-1',
      previous: { chat_tag_id: 'new', chat_sub_tag_id: null },
      saved: NEXT,
    });
    const [read, write] = queries;
    expect(read).toEqual([
      ['from', 'conversations'],
      ['select', 'id, contact_id, chat_tag_id, chat_sub_tag_id'],
      ['eq', 'account_id', 'acc-1'],
      ['eq', 'id', 'conv-1'],
      ['maybeSingle'],
    ]);
    // A compare-and-set on the tags read: eq for a value, is for null.
    expect(write).toEqual([
      ['from', 'conversations'],
      ['update', NEXT],
      ['eq', 'id', 'conv-1'],
      ['eq', 'account_id', 'acc-1'],
      ['eq', 'chat_tag_id', 'new'],
      ['is', 'chat_sub_tag_id', null],
      ['select', 'id, contact_id, chat_tag_id, chat_sub_tag_id'],
      ['maybeSingle'],
    ]);
  });

  it("finds a contact's most recently active conversation", async () => {
    const { db, queries } = fakeDb({
      read: { data: ROW, error: null },
      write: { data: ROW, error: null },
    });

    const res = await writeConversationChatTags(db, {
      accountId: 'acc-1',
      contactId: 'contact-1',
      next: { chat_tag_id: 'new', chat_sub_tag_id: null },
    });

    expect(res.ok).toBe(true);
    expect(queries[0]).toEqual([
      ['from', 'conversations'],
      ['select', 'id, contact_id, chat_tag_id, chat_sub_tag_id'],
      ['eq', 'account_id', 'acc-1'],
      ['eq', 'contact_id', 'contact-1'],
      ['order', 'last_message_at', { ascending: false, nullsFirst: false }],
      ['limit', 1],
      ['maybeSingle'],
    ]);
    // The update targets the row found, not the contact.
    expect(queries[1]).toContainEqual(['eq', 'id', 'conv-1']);
  });

  it('reports the row the server returned, e.g. a sub-tag the trigger cleared', async () => {
    const { db } = fakeDb({
      read: {
        data: { ...ROW, chat_tag_id: 'interested', chat_sub_tag_id: 'adcb' },
        error: null,
      },
      write: {
        data: { ...ROW, chat_tag_id: 'other', chat_sub_tag_id: null },
        error: null,
      },
    });

    const res = await writeConversationChatTags(db, {
      accountId: 'acc-1',
      conversationId: 'conv-1',
      next: { chat_tag_id: 'other', chat_sub_tag_id: 'adcb' },
    });

    expect(res).toMatchObject({
      ok: true,
      previous: { chat_tag_id: 'interested', chat_sub_tag_id: 'adcb' },
      saved: { chat_tag_id: 'other', chat_sub_tag_id: null },
    });
  });

  it('is not_found when no row is read', async () => {
    const { db, queries } = fakeDb({ read: { data: null, error: null } });
    const res = await writeConversationChatTags(db, {
      accountId: 'acc-1',
      conversationId: 'conv-1',
      next: NEXT,
    });
    expect(res).toEqual({ ok: false, reason: 'not_found' });
    expect(queries).toHaveLength(1);
  });

  it('is not_found when RLS filters the update', async () => {
    const { db, queries } = fakeDb({
      read: { data: ROW, error: null },
      write: { data: null, error: null },
    });
    const res = await writeConversationChatTags(db, {
      accountId: 'acc-1',
      conversationId: 'conv-1',
      next: NEXT,
    });
    expect(res).toEqual({ ok: false, reason: 'not_found' });
    // The re-read found the tags unchanged, so it did not retry.
    expect(queries).toHaveLength(3);
  });

  describe('when another writer changes the tags between read and write', () => {
    const UNTAGGED = { ...ROW, chat_tag_id: null, chat_sub_tag_id: null };

    it('reports no change when the other writer already set the same tags', async () => {
      const { db, queries } = fakeDb({
        reads: [
          { data: UNTAGGED, error: null },
          {
            data: {
              ...ROW,
              chat_tag_id: 'interested',
              chat_sub_tag_id: 'adcb',
            },
            error: null,
          },
        ],
        writes: [{ data: null, error: null }],
      });

      const res = await writeConversationChatTags(db, {
        accountId: 'acc-1',
        conversationId: 'conv-1',
        next: NEXT,
      });

      // previous === saved: callers dispatch chat_tag_set only on a change.
      expect(res).toEqual({
        ok: true,
        conversationId: 'conv-1',
        contactId: 'contact-1',
        previous: NEXT,
        saved: NEXT,
      });
      expect(queries[1]).toContainEqual(['is', 'chat_tag_id', null]);
      expect(queries[2]).toEqual([
        ['from', 'conversations'],
        ['select', 'id, contact_id, chat_tag_id, chat_sub_tag_id'],
        ['eq', 'account_id', 'acc-1'],
        ['eq', 'id', 'conv-1'],
        ['maybeSingle'],
      ]);
      expect(queries).toHaveLength(3);
    });

    it('retries from the fresh tags when the other writer set something else', async () => {
      const { db, queries } = fakeDb({
        reads: [
          { data: UNTAGGED, error: null },
          { data: { ...ROW, chat_tag_id: 'lead' }, error: null },
        ],
        writes: [
          { data: null, error: null },
          {
            data: {
              ...ROW,
              chat_tag_id: 'interested',
              chat_sub_tag_id: 'adcb',
            },
            error: null,
          },
        ],
      });

      const res = await writeConversationChatTags(db, {
        accountId: 'acc-1',
        conversationId: 'conv-1',
        next: NEXT,
      });

      expect(res).toMatchObject({
        ok: true,
        previous: { chat_tag_id: 'lead', chat_sub_tag_id: null },
        saved: NEXT,
      });
      expect(queries[3]).toEqual([
        ['from', 'conversations'],
        ['update', NEXT],
        ['eq', 'id', 'conv-1'],
        ['eq', 'account_id', 'acc-1'],
        ['eq', 'chat_tag_id', 'lead'],
        ['is', 'chat_sub_tag_id', null],
        ['select', 'id, contact_id, chat_tag_id, chat_sub_tag_id'],
        ['maybeSingle'],
      ]);
    });

    it('gives up with an error when the retry loses too', async () => {
      const { db, queries } = fakeDb({
        reads: [
          { data: UNTAGGED, error: null },
          { data: { ...ROW, chat_tag_id: 'lead' }, error: null },
          { data: { ...ROW, chat_tag_id: 'cold' }, error: null },
        ],
        writes: [
          { data: null, error: null },
          { data: null, error: null },
        ],
      });

      const res = await writeConversationChatTags(db, {
        accountId: 'acc-1',
        conversationId: 'conv-1',
        next: NEXT,
      });

      expect(res).toEqual({
        ok: false,
        reason: 'error',
        message: 'chat tags changed concurrently',
      });
      expect(queries).toHaveLength(5);
    });
  });

  describe('a write that names no sub-tag', () => {
    const TAGGED = {
      ...ROW,
      chat_tag_id: 'interested',
      chat_sub_tag_id: 'adcb',
    };

    it('keeps the sub-tag when the main tag is unchanged', async () => {
      const { db, queries } = fakeDb({
        read: { data: TAGGED, error: null },
        write: { data: TAGGED, error: null },
      });
      await writeConversationChatTags(db, {
        accountId: 'acc-1',
        conversationId: 'conv-1',
        next: { chat_tag_id: 'interested' },
      });
      expect(queries[1]).toContainEqual([
        'update',
        { chat_tag_id: 'interested', chat_sub_tag_id: 'adcb' },
      ]);
    });

    it('clears the sub-tag when the main tag changes', async () => {
      const { db, queries } = fakeDb({
        read: { data: TAGGED, error: null },
        write: { data: { ...TAGGED, chat_tag_id: 'lead' }, error: null },
      });
      await writeConversationChatTags(db, {
        accountId: 'acc-1',
        conversationId: 'conv-1',
        next: { chat_tag_id: 'lead' },
      });
      expect(queries[1]).toContainEqual([
        'update',
        { chat_tag_id: 'lead', chat_sub_tag_id: null },
      ]);
    });
  });

  it.each(['23514', '23503'])(
    'is invalid with the DB message on %s',
    async (code) => {
      const { db } = fakeDb({
        read: { data: ROW, error: null },
        write: {
          data: null,
          error: {
            code,
            message: "A chat's sub-tag must belong to its main tag",
          },
        },
      });
      const res = await writeConversationChatTags(db, {
        accountId: 'acc-1',
        conversationId: 'conv-1',
        next: NEXT,
      });
      expect(res).toEqual({
        ok: false,
        reason: 'invalid',
        message: "A chat's sub-tag must belong to its main tag",
      });
    }
  );

  it('is error on any other database failure, read or write', async () => {
    const readFail = fakeDb({
      read: { data: null, error: { code: '57014', message: 'timeout' } },
    });
    expect(
      await writeConversationChatTags(readFail.db, {
        accountId: 'acc-1',
        conversationId: 'conv-1',
        next: NEXT,
      })
    ).toEqual({ ok: false, reason: 'error', message: 'timeout' });

    const writeFail = fakeDb({
      read: { data: ROW, error: null },
      write: { data: null, error: { code: '42501', message: 'denied' } },
    });
    expect(
      await writeConversationChatTags(writeFail.db, {
        accountId: 'acc-1',
        conversationId: 'conv-1',
        next: NEXT,
      })
    ).toEqual({ ok: false, reason: 'error', message: 'denied' });
  });

  it('never throws', async () => {
    const { db } = fakeDb({ throwOn: 'read' });
    await expect(
      writeConversationChatTags(db, {
        accountId: 'acc-1',
        conversationId: 'conv-1',
        next: NEXT,
      })
    ).resolves.toEqual({ ok: false, reason: 'error', message: 'network' });
  });

  it('is invalid without a conversation or contact id', async () => {
    const { db, queries } = fakeDb({});
    const res = await writeConversationChatTags(db, {
      accountId: 'acc-1',
      next: NEXT,
    });
    expect(res).toMatchObject({ ok: false, reason: 'invalid' });
    expect(queries).toHaveLength(0);
  });
});

describe('resolveChatTagsWrite', () => {
  const prev = { chat_tag_id: 'interested', chat_sub_tag_id: 'adcb' };

  it.each([
    [
      'keeps the sub-tag when the main tag is unchanged',
      { chat_tag_id: 'interested' },
      prev,
    ],
    [
      'clears it when the main tag changes',
      { chat_tag_id: 'lead' },
      { chat_tag_id: 'lead', chat_sub_tag_id: null },
    ],
    [
      'clears it on an explicit null',
      { chat_tag_id: 'interested', chat_sub_tag_id: null },
      { chat_tag_id: 'interested', chat_sub_tag_id: null },
    ],
    [
      'sets a named sub-tag',
      { chat_tag_id: 'interested', chat_sub_tag_id: 'fab' },
      { chat_tag_id: 'interested', chat_sub_tag_id: 'fab' },
    ],
    [
      'clears both for a null main tag',
      { chat_tag_id: null },
      { chat_tag_id: null, chat_sub_tag_id: null },
    ],
  ])('%s', (_name, next, expected) => {
    expect(resolveChatTagsWrite(prev, next)).toEqual(expected);
  });
});
