import { describe, expect, it, vi } from 'vitest';

import { normalizeWhapiWebhook } from '@/lib/whatsapp/whapi-webhook';

import {
  applyGroupEvents,
  extractWhapiGroupMessages,
  GROUP_STATUS_PREDECESSORS,
  persistGroupMessages,
} from './inbound';
import { fakeSupabase, type FakeDb } from './test-db';
import type { WhapiGroupEvent } from '@/lib/whatsapp/whapi-group-events';

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

  it('keeps a shared contact card as the parsed card, not only its text', () => {
    const [m] = extractWhapiGroupMessages(
      body({
        id: 'g-card',
        from_me: false,
        type: 'contact',
        chat_id: GROUP,
        from: '971501234567',
        timestamp: 1700000000,
        contact: {
          name: 'Omar Khalid',
          vcard:
            'BEGIN:VCARD\nVERSION:3.0\nFN:Omar Khalid\nTEL;type=CELL;waid=971509876543:+971 50 987 6543\nEND:VCARD',
        },
      })
    );
    expect(m.type).toBe('contacts');
    expect(m.body).toBe('Contact: Omar Khalid');
    expect(m.media).toEqual({
      contacts: [
        {
          name: 'Omar Khalid',
          phones: ['+971 50 987 6543'],
          emails: [],
          org: null,
        },
      ],
    });
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

describe('persistGroupMessages', () => {
  it('stores our own echo as sent and a customer message with no status', async () => {
    const db: FakeDb = {
      writes: [],
      tables: {
        whatsapp_groups: [
          {
            id: 'g-1',
            account_id: 'acct-1',
            channel_id: 'ch-1',
            wa_group_id: GROUP,
          },
        ],
        whatsapp_group_messages: [],
      },
    };
    const m = (id: string, fromMe: boolean) => ({
      id,
      waGroupId: GROUP,
      fromMe,
      senderWaId: '971501234567',
      senderName: null,
      type: 'text',
      body: 'x',
      media: null,
      sentAt: new Date().toISOString(),
    });
    await persistGroupMessages(
      fakeSupabase(db) as never,
      { id: 'ch-1', accountId: 'acct-1', wabaId: null },
      [m('out-1', true), m('in-1', false)] as never
    );
    const byId = (id: string) =>
      db.tables.whatsapp_group_messages.find((r) => r.wa_message_id === id);
    expect(byId('out-1')).toMatchObject({ direction: 'out', status: 'sent' });
    expect(byId('in-1')).toMatchObject({ direction: 'in', status: null });
  });
});

describe('a submission group our number created (299)', () => {
  const ACCT = 'acct-1';
  const OUR = '971500000000';
  const MIRROR = '120363000000000299@g.us';
  const channel = { id: 'ch-1', accountId: ACCT, wabaId: OUR } as never;
  const fresh = (mirrored: boolean): FakeDb => ({
    writes: [],
    tables: {
      whatsapp_groups: [
        ['g-1', GROUP],
        ...(mirrored ? [['g-mirror', MIRROR]] : []),
      ].map(([id, wa_group_id]) => ({
        id,
        account_id: ACCT,
        channel_id: 'ch-1',
        wa_group_id,
        name: 'Deal team',
        our_role: 'admin',
      })),
      whatsapp_group_participants: [],
      whatsapp_group_managers: [],
      whatsapp_group_messages: [],
      whatsapp_group_tombstones: [],
      contacts: [],
      profiles: [{ user_id: 'own', account_id: ACCT, account_role: 'owner' }],
      notifications: [],
      submission_groups: [
        { account_id: ACCT, wa_group_id: MIRROR, status: 'ENDED' },
        // Another workspace's submission group does not count here.
        { account_id: 'acct-2', wa_group_id: GROUP, status: 'ACTIVE' },
      ],
    },
  });
  const upsert = (id: string) =>
    ({
      kind: 'group_upsert',
      group: {
        id,
        name: 'ACME x Taamul Credit',
        description: null,
        participantsCount: 1,
        participants: [{ id: '971501111111', rank: 'member' }],
        createdAt: null,
        createdBy: { waId: OUR },
        settings: {},
      },
    }) as unknown as WhapiGroupEvent;
  const participants = (action: string, groupId: string) =>
    ({
      kind: 'participants',
      groupId,
      action,
      waIds: ['971501111111'],
      unresolved: 0,
    }) as unknown as WhapiGroupEvent;
  const message = (id: string, waGroupId: string) => ({
    id,
    waGroupId,
    fromMe: false,
    senderWaId: '971501234567',
    senderName: null,
    type: 'text',
    body: 'x',
    media: null,
    sentAt: new Date().toISOString(),
  });

  it('makes no row from an upsert', async () => {
    const db = fresh(false);
    const admin = fakeSupabase(db) as never;
    expect(await applyGroupEvents(admin, channel, [upsert(MIRROR)])).toBe(0);
    expect(db.tables.whatsapp_groups.map((g) => g.id)).toEqual(['g-1']);
    expect(db.writes).toEqual([]);
  });

  it('writes nothing to a mirror, and still applies the rest', async () => {
    const db = fresh(true);
    const admin = fakeSupabase(db) as never;
    const events = [
      upsert(MIRROR),
      participants('add', MIRROR),
      participants('request', MIRROR),
    ];
    expect(await applyGroupEvents(admin, channel, events)).toBe(0);
    expect(db.writes).toEqual([]);
    await applyGroupEvents(admin, channel, [
      participants('add', MIRROR),
      participants('request', GROUP),
    ]);
    expect(db.tables.notifications).toMatchObject([
      { user_id: 'own', meta: { group_id: 'g-1' } },
    ]);
    expect(db.tables.whatsapp_group_participants).toEqual([]);
  });

  it('stores no message into a mirror, but does into the ordinary group', async () => {
    const db = fresh(true);
    await persistGroupMessages(fakeSupabase(db) as never, channel, [
      message('m-1', MIRROR),
      message('m-2', GROUP),
    ] as never);
    expect(db.tables.whatsapp_group_messages).toMatchObject([
      { group_id: 'g-1', wa_message_id: 'm-2' },
    ]);
  });

  it('throws and writes nothing when it cannot tell', async () => {
    const down = { code: '57014', message: 'down' };
    const db = fresh(true);
    db.errors = { 'submission_groups:select': down };
    const admin = fakeSupabase(db) as never;
    await expect(
      applyGroupEvents(admin, channel, [participants('request', GROUP)])
    ).rejects.toMatchObject(down);
    await expect(
      persistGroupMessages(admin, channel, [message('m-2', GROUP)] as never)
    ).rejects.toMatchObject(down);
    expect(db.writes).toEqual([]);
  });
});

describe('GROUP_STATUS_PREDECESSORS', () => {
  it('is forward-only, and failed only from pending/sent', () => {
    expect(GROUP_STATUS_PREDECESSORS.pending).toEqual([]);
    expect(GROUP_STATUS_PREDECESSORS.sent).toEqual(['pending']);
    expect(GROUP_STATUS_PREDECESSORS.delivered).toEqual([
      'pending',
      'sent',
      'failed',
    ]);
    expect(GROUP_STATUS_PREDECESSORS.read).toEqual([
      'pending',
      'sent',
      'delivered',
      'failed',
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
          // The managers are staff of the workspace too; one has left it.
          { user_id: 'm1', account_id: ACCT, account_role: 'agent' },
          { user_id: 'm2', account_id: ACCT, account_role: 'agent' },
          {
            user_id: 'gone',
            account_id: ACCT,
            account_role: 'agent',
            deactivated_at: '2026-11-01T00:00:00Z',
          },
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

  it('falls back when every manager is deactivated, and never rings one', async () => {
    const gone = { group_id: 'g-1', account_id: ACCT, user_id: 'gone' };
    const only = setup({ whatsapp_group_managers: [gone] });
    await applyGroupEvents(only.admin, channel, [event]);
    expect(bells(only.db).map((n) => n.user_id)).toEqual(['owner']);
    const both = setup({
      whatsapp_group_managers: [gone, { ...gone, user_id: 'm1' }],
    });
    await applyGroupEvents(both.admin, channel, [event]);
    expect(bells(both.db).map((n) => n.user_id)).toEqual(['m1']);
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

describe('applyGroupEvents: a group deleted for good', () => {
  const OUR = '971500000000';
  const WA = '120363000000000099@g.us';
  const tombstoned = {
    id: 'ch-1',
    accountId: 'acct-1',
    wabaId: OUR,
  };
  const upsert = {
    kind: 'group_upsert',
    group: {
      id: WA,
      name: 'Gone',
      description: null,
      participantsCount: 0,
      participants: [],
      createdAt: null,
      createdBy: { waId: OUR },
      settings: {},
    },
  } as unknown as WhapiGroupEvent;
  const fresh = (): FakeDb => ({
    tables: {
      whatsapp_groups: [],
      whatsapp_group_participants: [],
      contacts: [],
      whatsapp_group_tombstones: [
        { account_id: 'acct-1', channel_id: 'ch-1', wa_group_id: WA },
      ],
    },
  });

  it('is not recreated by a group_upsert of our own group', async () => {
    const d = fresh();
    const failed = await applyGroupEvents(
      fakeSupabase(d) as never,
      tombstoned as never,
      [upsert]
    );
    expect(failed).toBe(0);
    expect(d.tables.whatsapp_groups).toEqual([]);
  });

  it('is created as before when it has no tombstone', async () => {
    const d = fresh();
    d.tables.whatsapp_group_tombstones = [];
    await applyGroupEvents(fakeSupabase(d) as never, tombstoned as never, [
      upsert,
    ]);
    expect(d.tables.whatsapp_groups).toHaveLength(1);
  });

  it('does not throw and skips when the tombstone read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = fresh();
    d.errors = { 'whatsapp_group_tombstones:select': { message: 'down' } };
    await expect(
      applyGroupEvents(fakeSupabase(d) as never, tombstoned as never, [upsert])
    ).resolves.toBe(1);
    expect(d.tables.whatsapp_groups).toEqual([]);
  });
});
