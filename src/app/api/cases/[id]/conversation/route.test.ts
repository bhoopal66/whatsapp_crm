import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

// The send-limit count: from().select().eq()...gte() resolves to countResult.
const chain: Record<string, unknown> = {};
chain.select = () => chain;
chain.eq = (col: string, val: unknown) => (m.eqs.push([col, val]), chain);
chain.gte = () => Promise.resolve(m.countResult);
const admin = { from: () => chain };

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
vi.mock('@/lib/submission-groups/view-refs', () => ({
  loadNames: m.loadNames,
}));

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
  };
  m.conv = { read: vi.fn(), reply: vi.fn() };
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
      messages: [message],
    });
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(m.convAccount).toEqual(['acct-1']);
    expect(m.loadNames).toHaveBeenCalledWith(admin, 'acct-1', ['u-2']);
    expect(body).toMatchObject({ groupId: 'g-1', archived: true });
    expect(body.messages[0]).toMatchObject({
      id: 'msg-1',
      sender_name: 'Sara',
      prefixed_body: '*Sara*: hello',
      created_at: '2026-10-01T10:00:00.000Z',
    });
  });
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
