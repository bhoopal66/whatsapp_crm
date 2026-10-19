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
  caseConversations: () => m.conv,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => admin,
}));
vi.mock('@/lib/submission-groups/view-refs', () => ({
  loadNames: m.loadNames,
}));

import { CaseTakeOverRefusedError } from '@/lib/cases/conversations';
import {
  SubmissionGroupSendBlockedError,
  SubmissionGroupSentNotRecordedError,
} from '@/lib/submission-groups/service';
import { POST } from './route';

const USER = 'u-me';
const ID = '11111111-1111-4111-8111-111111111111';
const aCase = (over: Record<string, unknown> = {}) => ({
  id: ID,
  accountId: 'acct-1',
  groupId: 'g-1',
  agentId: 'u-agent',
  bankName: 'ADCB',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
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
  m.conv = { takeOver: vi.fn() };
  m.loadNames.mockResolvedValue(new Map([['u-agent', 'Sara Ali']]));
});

const post = (id = ID) =>
  POST(new Request(`http://x/api/cases/${id}/takeover`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  });

describe('POST /api/cases/[id]/takeover', () => {
  it('is 404 for another account (no role call) and for no role', async () => {
    m.store.get.mockResolvedValue(aCase({ accountId: 'acct-2' }));
    expect((await post()).status).toBe(404);
    expect(m.store.role).not.toHaveBeenCalled();
    m.store.get.mockResolvedValue(aCase());
    m.store.role.mockResolvedValue(null);
    expect((await post()).status).toBe(404);
    expect(m.conv.takeOver).not.toHaveBeenCalled();
  });

  it("takes over with the agent's display name and the bank's name", async () => {
    m.conv.takeOver.mockResolvedValue({
      logId: '7',
      templateVersion: 'v1',
      messageId: 'msg-1',
      prefixedBody: 'x',
      waMessageId: 'wa-1',
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ logId: '7', sent: true });
    expect(m.loadNames).toHaveBeenCalledWith(admin, 'acct-1', ['u-agent']);
    expect(m.conv.takeOver).toHaveBeenCalledWith('u-me', ID, {
      agentName: 'Sara Ali',
      bankName: 'ADCB',
    });
  });

  it('passes empty names for the lib to refuse when missing', async () => {
    m.store.get.mockResolvedValue(aCase({ bankName: null }));
    m.loadNames.mockResolvedValue(new Map());
    m.conv.takeOver.mockRejectedValue(
      new CaseTakeOverRefusedError('NAME_INVALID')
    );
    const res = await post();
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'NAME_INVALID' });
    expect(m.conv.takeOver).toHaveBeenCalledWith('u-me', ID, {
      agentName: '',
      bankName: '',
    });
  });

  it.each([
    ['TEMPLATE_NOT_APPROVED', 409],
    ['NOT_ALLOWED', 403],
    ['TEMPLATE_INVALID', 422],
    ['NAME_INVALID', 422],
    ['CASE_NOT_FOUND', 404],
  ] as const)('maps %s to %i', async (code, status) => {
    m.conv.takeOver.mockRejectedValue(new CaseTakeOverRefusedError(code));
    const res = await post();
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code });
  });

  it('maps a send block after the log row to 409 and sent-not-recorded to 200', async () => {
    m.conv.takeOver.mockRejectedValue(
      new SubmissionGroupSendBlockedError('do_not_contact')
    );
    let res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'SEND_BLOCKED' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.conv.takeOver.mockRejectedValue(
      new SubmissionGroupSentNotRecordedError('msg-1', 'wa-1', null)
    );
    res = await post();
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, recorded: false });
  });
});

describe('takeover: group send limit', () => {
  it('is 429 SEND_RATE_LIMITED at the limit and does nothing', async () => {
    m.countResult = { count: 20, error: null };
    const res = await post();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'SEND_RATE_LIMITED' });
    expect(m.conv.takeOver).not.toHaveBeenCalled();
  });

  it("counts the caller's out rows in the case's group", async () => {
    await post();
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
    expect((await post()).status).toBeLessThan(300);
    expect(m.conv.takeOver).toHaveBeenCalled();
  });

  it('is 503 when the count fails, and does nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.countResult = { count: null, error: { message: 'boom' } };
    const res = await post();
    expect(res.status).toBe(503);
    expect(m.conv.takeOver).not.toHaveBeenCalled();
  });
});
