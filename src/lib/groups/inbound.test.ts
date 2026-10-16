import { describe, expect, it, vi } from 'vitest';

import { normalizeWhapiWebhook } from '@/lib/whatsapp/whapi-webhook';

import {
  applyGroupEvents,
  extractWhapiGroupMessages,
  GROUP_STATUS_PREDECESSORS,
} from './inbound';
import { fakeSupabase, type FakeDb } from './test-db';

const GROUP = '120363025555555555@g.us';

function body(...messages: Record<string, unknown>[]) {
  return {
    messages,
    event: { type: 'messages', event: 'post' },
    channel_id: 'CHANNEL-1',
  };
}

describe('extractWhapiGroupMessages', () => {
  it('reads a group text message', () => {
    const out = extractWhapiGroupMessages(
      body({
        id: 'g-1',
        from_me: false,
        type: 'text',
        chat_id: GROUP,
        from: '971501234567',
        from_name: 'Ada',
        timestamp: 1700000000,
        text: { body: 'hello group' },
      })
    );
    expect(out).toEqual([
      {
        id: 'g-1',
        waGroupId: GROUP,
        fromMe: false,
        senderWaId: '971501234567',
        senderName: 'Ada',
        type: 'text',
        body: 'hello group',
        media: null,
        sentAt: new Date(1700000000 * 1000).toISOString(),
      },
    ]);
  });

  it('keeps media id, link, mime type and filename, and our own sends', () => {
    const [m] = extractWhapiGroupMessages(
      body({
        id: 'g-2',
        from_me: true,
        type: 'document',
        chat_id: GROUP,
        from: '15551230000@s.whatsapp.net',
        timestamp: '1700000001',
        document: {
          id: 'media-1',
          link: 'https://gate.whapi.cloud/media/1',
          mime_type: 'application/pdf',
          file_name: 'offer.pdf',
          file_size: 1234,
          caption: 'the offer',
        },
      })
    );
    expect(m.fromMe).toBe(true);
    expect(m.senderWaId).toBe('15551230000');
    expect(m.type).toBe('document');
    expect(m.body).toBe('the offer');
    expect(m.media).toEqual({
      id: 'media-1',
      link: 'https://gate.whapi.cloud/media/1',
      mime_type: 'application/pdf',
      filename: 'offer.pdf',
      file_size: 1234,
    });
  });

  it('keeps a hidden number as its LID', () => {
    const [m] = extractWhapiGroupMessages(
      body({
        id: 'g-3',
        type: 'text',
        chat_id: GROUP,
        from: '123456789012345@lid',
        text: { body: 'x' },
      })
    );
    expect(m.senderWaId).toBe('123456789012345@lid');
  });

  it('skips 1:1 chats, broadcast lists, reactions and actions', () => {
    const out = extractWhapiGroupMessages(
      body(
        {
          id: 'a',
          type: 'text',
          chat_id: '15551230000@s.whatsapp.net',
          text: { body: '1:1' },
        },
        {
          id: 'b',
          type: 'text',
          chat_id: 'status@broadcast',
          text: { body: 'list' },
        },
        {
          id: 'c',
          type: 'action',
          chat_id: GROUP,
          action: { type: 'reaction', target: 'g-1', emoji: '👍' },
        },
        { id: 'd', type: 'action', chat_id: GROUP, action: { type: 'delete' } },
        { type: 'text', chat_id: GROUP, text: { body: 'no id' } }
      )
    );
    expect(out).toEqual([]);
  });

  it('tolerates a body with no messages or junk items', () => {
    expect(extractWhapiGroupMessages(null)).toEqual([]);
    expect(extractWhapiGroupMessages({ messages: 'x' })).toEqual([]);
    expect(extractWhapiGroupMessages({ messages: [null, 3] })).toEqual([]);
  });

  it('is the only reader of group chats: the normaliser still drops them', () => {
    const raw = body({
      id: 'g-1',
      type: 'text',
      chat_id: GROUP,
      from: '971501234567',
      text: { body: 'hello group' },
    });
    expect(normalizeWhapiWebhook(raw).messages).toEqual([]);
    expect(extractWhapiGroupMessages(raw)).toHaveLength(1);
  });
});

describe('GROUP_STATUS_PREDECESSORS', () => {
  it('is forward-only, and failed only from pending/sent', () => {
    expect(GROUP_STATUS_PREDECESSORS.pending).toEqual([]);
    expect(GROUP_STATUS_PREDECESSORS.sent).toEqual(['pending']);
    expect(GROUP_STATUS_PREDECESSORS.delivered).toEqual(['pending', 'sent']);
    expect(GROUP_STATUS_PREDECESSORS.read).toEqual([
      'pending',
      'sent',
      'delivered',
    ]);
    expect(GROUP_STATUS_PREDECESSORS.failed).toEqual(['pending', 'sent']);
  });
});

describe('applyGroupEvents: a join request', () => {
  const ACCT = 'acct-1';
  const channel = { id: 'ch-1', accountId: ACCT, wabaId: '971500000000' };
  const event = {
    kind: 'participants',
    groupId: GROUP,
    action: 'request',
    waIds: ['971501111111'],
    unresolved: 0,
  } as never;
  function setup(extra: Partial<FakeDb['tables']> = {}) {
    const db: FakeDb = {
      writes: [],
      tables: {
        whatsapp_groups: [
          {
            id: 'g-1',
            account_id: ACCT,
            channel_id: 'ch-1',
            wa_group_id: GROUP,
            name: 'Deal team',
            our_role: 'admin',
          },
        ],
        whatsapp_group_managers: [],
        profiles: [
          { user_id: 'owner', account_id: ACCT, account_role: 'owner' },
          { user_id: 'agent', account_id: ACCT, account_role: 'agent' },
        ],
        notifications: [],
        ...extra,
      },
    };
    return { db, admin: fakeSupabase(db) as never };
  }
  const bells = (db: FakeDb) =>
    db.tables.notifications.filter((n) => n.type === 'group_join_request');

  it('rings each manager, not the rest', async () => {
    const { db, admin } = setup({
      whatsapp_group_managers: [
        { group_id: 'g-1', account_id: ACCT, user_id: 'm1' },
        { group_id: 'g-1', account_id: ACCT, user_id: 'm2' },
      ],
    });
    expect(await applyGroupEvents(admin, channel, [event])).toBe(0);
    expect(bells(db).map((n) => n.user_id)).toEqual(['m1', 'm2']);
    expect(bells(db)[0]).toMatchObject({
      title: 'Join request: Deal team',
      meta: { group_id: 'g-1', wa_ids: ['971501111111'] },
    });
  });

  it('falls back to owners and admins when nobody manages it', async () => {
    const { db, admin } = setup();
    await applyGroupEvents(admin, channel, [event]);
    expect(bells(db).map((n) => n.user_id)).toEqual(['owner']);
  });

  it('skips a manager with an unread bell for the group in the last 10 minutes', async () => {
    const { db, admin } = setup({
      whatsapp_group_managers: [
        { group_id: 'g-1', account_id: ACCT, user_id: 'm1' },
        { group_id: 'g-1', account_id: ACCT, user_id: 'm2' },
      ],
      notifications: [
        {
          account_id: ACCT,
          user_id: 'm1',
          type: 'group_join_request',
          'meta->>group_id': 'g-1',
          read_at: null,
          created_at: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });
    await applyGroupEvents(admin, channel, [event]);
    expect(bells(db).map((n) => n.user_id)).toEqual(['m1', 'm2']);
    expect(bells(db).filter((n) => n.title)).toHaveLength(1);
    expect(bells(db).find((n) => n.title)?.user_id).toBe('m2');
  });

  it('never throws when the bell cannot be written', async () => {
    const { db, admin } = setup();
    db.errors = { 'notifications:insert': { message: 'boom' } };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await applyGroupEvents(admin, channel, [event])).toBe(0);
    log.mockRestore();
  });
});
