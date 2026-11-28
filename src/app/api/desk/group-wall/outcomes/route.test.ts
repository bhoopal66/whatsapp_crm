import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({ rpc: m.rpc }),
}));

import { POST } from './route';

const id = (n: number) =>
  `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const post = (body: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-1',
    accountId: 'acc-active',
    salesRestricted: false,
  });
  m.rpc.mockResolvedValue({ data: [], error: null });
});

describe('POST /api/desk/group-wall/outcomes', () => {
  it('reads the outcomes as the caller in the active account', async () => {
    m.rpc.mockResolvedValue({
      data: [
        {
          group_message_id: id(1),
          outcome: 'queued',
          detail: 'NO_CODE',
          reply_state: 'sent',
          item_state: 'filed',
          case_number: 'TC-26-00412-RAK',
          caption_code: null,
          doc_key: 'ejari',
          queue_reason: null,
        },
      ],
      error: null,
    });
    const res = await post({ messageIds: [id(1), id(1), id(2)] });
    expect(res.status).toBe(200);
    const [fn, args] = m.rpc.mock.lastCall!;
    expect(fn).toBe('desk_group_outcomes');
    expect(args).toEqual({
      p_actor: 'u-1',
      p_account: 'acc-active',
      p_message_ids: [id(1), id(2)],
    });
    expect((await res.json()).outcomes).toEqual([
      expect.objectContaining({
        groupMessageId: id(1),
        itemState: 'filed',
        replyState: 'sent',
      }),
    ]);
  });

  it('refuses a malformed body or more than 500 ids before the database', async () => {
    for (const body of [
      {},
      { messageIds: 'x' },
      { messageIds: ['nope'] },
      { messageIds: Array.from({ length: 501 }, () => id(1)) },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('500 ids are accepted', async () => {
    const res = await post({
      messageIds: Array.from({ length: 500 }, (_, i) => id(i)),
    });
    expect(res.status).toBe(200);
  });

  it('maps a refusal with DESK_REFUSAL_HTTP', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: '23514', hint: 'NOT_ALLOWED', message: 'x' },
    });
    expect((await post({ messageIds: [id(1)] })).status).toBe(403);
  });
});
