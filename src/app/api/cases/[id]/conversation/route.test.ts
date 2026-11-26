import { beforeEach, describe, expect, it, vi } from 'vitest';

// 022b: `after` runs nothing in a unit test; the brain sink is stubbed.
const brain = vi.hoisted(() => ({
  record: vi.fn(async () => {}),
  after: [] as (() => unknown)[],
}));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (cb: () => unknown) => {
    brain.after.push(cb);
  },
}));
vi.mock('@/lib/brain/sink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/brain/sink')>()),
  brainSink: () => ({ record: brain.record }),
}));

const m = vi.hoisted(() => ({
  countResult: { count: 0, error: null } as {
    count: number | null;
    error: unknown;
  },
  eqs: [] as unknown[][],
  getCurrentAccount: vi.fn(),
  loadNames: vi.fn(),
  store: {} as Record<string, ReturnType<typeof vi.fn>>,
  conv: {} as Record<string, ReturnType<typeof vi.fn>>,
  convAccount: [] as unknown[],
  probeDb: null as null | { from: (table: string) => unknown },
}));

// The send-limit count: from().select().eq()...gte() resolves to countResult.
const chain: Record<string, unknown> = {};
chain.select = () => chain;
chain.eq = (col: string, val: unknown) => (m.eqs.push([col, val]), chain);
chain.gte = () => Promise.resolve(m.countResult);
const admin = {
  from: (table: string): unknown => (m.probeDb ? m.probeDb.from(table) : chain),
};

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  caseStore: () => m.store,
  caseConversations: (accountId: string) => (
    m.convAccount.push(accountId),
    m.conv
  ),
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => admin,
}));
vi.mock('@/lib/supabase/urls', () => ({
  publicSupabaseUrl: () => 'https://crm.example/supabase',
}));
vi.mock('@/lib/submission-groups/view-refs', () => ({
  loadNames: m.loadNames,
}));

import { FakeClient, type Query } from '@/lib/cases/read-fakes';
import { CaseRefusedError } from '@/lib/cases/store';
import {
  SubmissionGroupSendBlockedError,
  SubmissionGroupSendRefusedError,
  SubmissionGroupSentNotRecordedError,
} from '@/lib/submission-groups/service';
import { GET, POST } from './route';

const USER = 'u-me';
const ID = '11111111-1111-4111-8111-111111111111';
const aCase = (over: Record<string, unknown> = {}) => ({
  id: ID,
  accountId: 'acct-1',
  groupId: 'g-1',
  ...over,
});
const message = {
  id: 'msg-1',
  direction: 'out',
  senderUserId: 'u-2',
  senderWaId: null,
  senderKind: 'staff',
  type: 'text',
  body: 'hello',
  prefixedBody: '*Sara*: hello',
  media: null,
  waMessageId: 'wa-1',
  waTimestamp: null,
  sendStatus: 'sent',
  postEnd: false,
  createdAt: new Date('2026-10-01T10:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  m.convAccount.length = 0;
  m.probeDb = null;
  m.countResult = { count: 0, error: null };
  m.eqs.length = 0;
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-me',
    accountId: 'acct-1',
    role: 'agent',
  });
  m.store = {
    get: vi.fn(async () => aCase()),
    role: vi.fn(async () => 'coordinator'),
    viewCases: vi.fn(async () => [ID]),
  };
  m.conv = { read: vi.fn(), reply: vi.fn(), replyMedia: vi.fn() };
  m.loadNames.mockResolvedValue(new Map([['u-2', 'Sara']]));
});

const p = (id = ID) => ({ params: Promise.resolve({ id }) });
const get = (id = ID) =>
  GET(new Request(`http://x/api/cases/${id}/conversation`), p(id));
const post = (body: unknown, id = ID) =>
  POST(
    new Request(`http://x/api/cases/${id}/conversation`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    p(id)
  );

describe('GET /api/cases/[id]/conversation', () => {
  it('is 404 for another account (no role call, no read) and for no role', async () => {
    m.store.get.mockResolvedValue(aCase({ accountId: 'acct-2' }));
    expect((await get()).status).toBe(404);
    expect(m.store.role).not.toHaveBeenCalled();
    expect(m.conv.read).not.toHaveBeenCalled();
    m.store.get.mockResolvedValue(aCase());
    m.store.role.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    expect(m.conv.read).not.toHaveBeenCalled();
  });

  it('is 404 NOT_READABLE when the audited read refuses', async () => {
    m.conv.read.mockResolvedValue({ allowed: false });
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_READABLE' });
    expect(m.conv.read).toHaveBeenCalledWith('u-me', ID);
  });

  it('answers the group, archive flag and message views with names', async () => {
    m.conv.read.mockResolvedValue({
      allowed: true,
      groupId: 'g-1',
      archived: true,
      waMode: 'group',
      messages: [message],
    });
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(m.convAccount).toEqual(['acct-1']);
    expect(m.loadNames).toHaveBeenCalledWith(admin, 'acct-1', ['u-2']);
    expect(body).toMatchObject({
      groupId: 'g-1',
      archived: true,
      waMode: 'group',
    });
    expect(body.messages[0]).toMatchObject({
      id: 'msg-1',
      sender_name: 'Sara',
      prefixed_body: '*Sara*: hello',
      created_at: '2026-10-01T10:00:00.000Z',
    });
  });
});

describe('GET /api/cases/[id]/conversation?since', () => {
  const SINCE = '2026-10-01T10:00:00.123Z';
  const probeDb = (newest: string | null, status = 'ACTIVE') => {
    const db = new FakeClient(
      'admin',
      [],
      {},
      {
        submission_groups: () => ({
          data: [{ id: 'g-1', status, created_at: SINCE, wa_mode: 'group' }],
        }),
        submission_group_messages: () => ({
          data: newest ? [{ created_at: newest }] : [],
        }),
      }
    );
    m.probeDb = db;
    return db;
  };
  const probe = (since = SINCE) =>
    GET(
      new Request(
        `http://x/api/cases/${ID}/conversation?since=${encodeURIComponent(since)}`
      ),
      p()
    );

  it('says whether there is something new, without reading or auditing', async () => {
    const db = probeDb('2026-10-01T10:05:00.000001+00:00');
    const res = await probe();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: true });
    // view_case is reached through either of these, and nothing else.
    expect(m.conv.read).not.toHaveBeenCalled();
    expect(m.store.viewCases).not.toHaveBeenCalled();
    expect(db.rpcs).toEqual([]);
    expect(m.convAccount).toEqual([]);

    const [q]: Query[] = db.queriesOf('submission_group_messages');
    expect(q).toMatchObject({
      columns: 'created_at',
      filters: [
        ['eq', 'group_id', 'g-1'],
        ['eq', 'post_end', false],
      ],
      orders: ['created_at', 'id'],
      limit: 1,
    });
    expect(db.queriesOf('submission_groups')[0].filters).toContainEqual([
      'eq',
      'account_id',
      'acct-1',
    ]);
  });

  it('compares in milliseconds, as the view shows them', async () => {
    probeDb('2026-10-01T10:00:00.123456+00:00');
    expect(await (await probe()).json()).toEqual({ changed: false });
    probeDb('2026-10-01T10:00:00.124000+00:00');
    expect(await (await probe()).json()).toEqual({ changed: true });
  });

  it('an empty chat is unchanged from the epoch', async () => {
    probeDb(null);
    expect(await (await probe(new Date(0).toISOString())).json()).toEqual({
      changed: false,
    });
    // The newest message shown was removed.
    expect(await (await probe()).json()).toEqual({ changed: true });
  });

  it('an ended or missing group counts as changed, its messages unread', async () => {
    const ended = probeDb(SINCE, 'ENDED');
    expect(await (await probe()).json()).toEqual({ changed: true });
    expect(ended.queriesOf('submission_group_messages')).toEqual([]);
    m.store.get.mockResolvedValue(aCase({ groupId: null }));
    expect(await (await probe()).json()).toEqual({ changed: true });
  });

  it('is 404 without a role on the case, 400 for a bad time, 500 when a read fails', async () => {
    const db = probeDb(SINCE);
    expect((await probe('yesterday')).status).toBe(400);
    m.store.role.mockResolvedValue(null);
    expect((await probe()).status).toBe(404);
    expect(db.queries).toEqual([]);
    m.store.role.mockResolvedValue('agent');
    db.tables.submission_group_messages = () => ({ error: { code: '57014' } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await probe()).status).toBe(500);
    err.mockRestore();
  });
});

describe('GET /api/cases/[id]/conversation waMode (136)', () => {
  it.each(['none', 'group', null] as const)(
    'passes waMode %s through',
    async (waMode) => {
      m.conv.read.mockResolvedValue({
        allowed: true,
        groupId: waMode ? 'g-1' : null,
        archived: false,
        waMode,
        messages: [],
      });
      const body = await (await get()).json();
      expect(body.waMode).toBe(waMode);
    }
  );
});

describe('POST /api/cases/[id]/conversation', () => {
  it('is 404 for another account and for no role', async () => {
    m.store.get.mockResolvedValue(aCase({ accountId: 'acct-2' }));
    expect((await post({ text: 'hi' })).status).toBe(404);
    m.store.get.mockResolvedValue(aCase());
    m.store.role.mockResolvedValue(null);
    expect((await post({ text: 'hi' })).status).toBe(404);
    expect(m.conv.reply).not.toHaveBeenCalled();
  });

  it('is 400 for a blank or over-long text', async () => {
    expect((await post({ text: '   ' })).status).toBe(400);
    expect((await post({ text: 'x'.repeat(4097) })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(m.conv.reply).not.toHaveBeenCalled();
  });

  it('replies with the trimmed text and answers 201', async () => {
    m.conv.reply.mockResolvedValue({
      messageId: 'msg-9',
      prefixedBody: '*Me*: hi',
      waMessageId: 'wa-9',
    });
    const res = await post({ text: '  hi  ' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      sent: true,
      recorded: true,
      messageId: 'msg-9',
    });
    expect(m.conv.reply).toHaveBeenCalledWith('u-me', ID, 'hi');
  });

  it.each([
    ['GROUP_NOT_READY', new SubmissionGroupSendRefusedError('GROUP_NOT_READY')],
    [
      'SEND_NOT_ALLOWED',
      new SubmissionGroupSendRefusedError('SEND_NOT_ALLOWED'),
    ],
    ['SEND_BLOCKED', new SubmissionGroupSendBlockedError('opted_out')],
  ] as const)('maps %s to 409', async (code, err) => {
    m.conv.reply.mockRejectedValue(err);
    const res = await post({ text: 'hi' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code });
  });

  it('answers 200 sent-not-recorded, 403 NOT_ALLOWED, 500 otherwise', async () => {
    m.conv.reply.mockRejectedValue(
      new SubmissionGroupSentNotRecordedError('msg-1', 'wa-1', null)
    );
    let res = await post({ text: 'hi' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, recorded: false });
    m.conv.reply.mockRejectedValue(new CaseRefusedError('NOT_ALLOWED'));
    expect((await post({ text: 'hi' })).status).toBe(403);
    m.conv.reply.mockRejectedValue(new Error('gateway said +971501234567'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    res = await post({ text: 'hi' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('+971');
    spy.mockRestore();
  });
});

describe('POST /api/cases/[id]/conversation: an attachment', () => {
  const path = 'account-acct-1/groups/1700000000000-voice-1.ogg';
  const media = (over: Record<string, unknown> = {}) => ({
    media: {
      kind: 'voice',
      url: `https://anything.example/storage/v1/object/public/chat-media/${path}`,
      path,
      mimeType: 'audio/ogg',
      ...over,
    },
  });
  const sent = {
    messageId: 'msg-9',
    prefixedBody: '*Me*',
    waMessageId: 'wa-9',
  };

  it('sends the upload by a link rebuilt on our origin, never the given one', async () => {
    m.conv.replyMedia.mockResolvedValue(sent);
    const res = await post(media());
    expect(res.status).toBe(201);
    expect(m.conv.reply).not.toHaveBeenCalled();
    expect(m.conv.replyMedia).toHaveBeenCalledTimes(1);
    const [actor, caseId, input] = m.conv.replyMedia.mock.calls[0];
    expect([actor, caseId]).toEqual(['u-me', ID]);
    expect(input).toMatchObject({
      kind: 'voice',
      path,
      mimeType: 'audio/ogg',
    });
    expect(input.link).toBe(
      `https://crm.example/supabase/storage/v1/object/public/chat-media/${path}`
    );
  });

  it.each([
    [
      "another account's file",
      {
        url: 'https://x.example/storage/v1/object/public/chat-media/account-acct-2/groups/v.ogg',
        path: 'account-acct-2/groups/v.ogg',
      },
    ],
    [
      'a file outside the groups folder',
      {
        url: 'https://x.example/storage/v1/object/public/chat-media/account-acct-1/staged/v.ogg',
        path: 'account-acct-1/staged/v.ogg',
      },
    ],
    ['a url that names another file', { path: `${path}x` }],
    ['an unknown kind', { kind: 'sticker' }],
    ['a caption that is too long', { caption: 'x'.repeat(5000) }],
  ])('is 400 for %s, and nothing is sent', async (_, over) => {
    expect((await post(media(over))).status).toBe(400);
    expect(m.conv.replyMedia).not.toHaveBeenCalled();
    expect(m.conv.reply).not.toHaveBeenCalled();
  });

  it('is under the same checks as a text', async () => {
    m.store.role.mockResolvedValue(null);
    expect((await post(media())).status).toBe(404);
    m.store.role.mockResolvedValue('coordinator');
    m.countResult = { count: 20, error: null };
    expect((await post(media())).status).toBe(429);
    m.countResult = { count: 0, error: null };
    m.conv.replyMedia.mockRejectedValue(
      new SubmissionGroupSendBlockedError('opted_out')
    );
    const res = await post(media());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'SEND_BLOCKED' });
  });

  it('remembers a caption, and nothing for a voice note', async () => {
    brain.after.length = 0;
    m.conv.replyMedia.mockResolvedValue(sent);
    await post(media());
    expect(brain.after).toHaveLength(0);
    await post(media({ kind: 'image', caption: ' the licence ' }));
    for (const cb of brain.after) await cb();
    expect(brain.record).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-9', text: 'the licence' })
    );
  });
});

describe('conversation POST: group send limit', () => {
  it('is 429 SEND_RATE_LIMITED at the limit and does nothing', async () => {
    m.countResult = { count: 20, error: null };
    const res = await post({ text: 'hi' });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'SEND_RATE_LIMITED' });
    expect(m.conv.reply).not.toHaveBeenCalled();
  });

  it("counts the caller's out rows in the case's group", async () => {
    await post({ text: 'hi' });
    expect(m.eqs).toEqual(
      expect.arrayContaining([
        ['account_id', 'acct-1'],
        ['group_id', 'g-1'],
        ['direction', 'out'],
        ['sender_user_id', USER],
      ])
    );
  });

  it('proceeds under the limit', async () => {
    m.countResult = { count: 19, error: null };
    expect((await post({ text: 'hi' })).status).toBeLessThan(300);
    expect(m.conv.reply).toHaveBeenCalled();
  });

  it('is 503 when the count fails, and does nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.countResult = { count: null, error: { message: 'boom' } };
    const res = await post({ text: 'hi' });
    expect(res.status).toBe(503);
    expect(m.conv.reply).not.toHaveBeenCalled();
  });
});

describe('conversation POST: second-brain hook', () => {
  it('records the staff text (not the prefixed body) as the caller', async () => {
    brain.after.length = 0;
    m.conv.reply.mockResolvedValue({
      messageId: 'msg-9',
      prefixedBody: '*Me*: hi',
      waMessageId: 'wa-9',
    });
    expect((await post({ text: '  hi  ' })).status).toBe(201);
    for (const cb of brain.after) await cb();
    expect(brain.record).toHaveBeenCalledTimes(1);
    expect(brain.record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'message',
        messageId: 'msg-9',
        text: 'hi',
        ref: expect.objectContaining({
          accountId: 'acct-1',
          caseId: ID,
          createdBy: 'u-me',
        }),
      })
    );
  });

  it('registers nothing when the send is refused', async () => {
    brain.after.length = 0;
    m.conv.reply.mockRejectedValue(
      new SubmissionGroupSendRefusedError('GROUP_NOT_READY')
    );
    expect((await post({ text: 'hi' })).status).toBe(409);
    for (const cb of brain.after) await cb();
    expect(brain.after).toHaveLength(0);
    expect(brain.record).not.toHaveBeenCalled();
  });
});
