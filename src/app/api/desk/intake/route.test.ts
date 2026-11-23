import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  rpc: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
  requireRole: m.requireRole,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({
    rpc: m.rpc,
    storage: { from: () => ({ upload: m.upload, remove: m.remove }) },
  }),
}));

import { ForbiddenError } from '@/lib/auth/account';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

import { POST } from './route';

const ctx = {
  userId: 'u-1',
  accountId: 'acc-1',
  salesRestricted: false,
};

const RESULT = {
  item_id: 'i-1',
  state: 'filed',
  case_id: 'c-1',
  case_number: 'TC-26-00001-RAK',
  caption_code: '1RAK1',
  file_id: null,
  duplicate_of_item: null,
  queue_bank_code: null,
  queue_reason: null,
  replayed: false,
};

function post(fields: Record<string, string | File>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return POST(new Request('http://x', { method: 'POST', body: form }));
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitForTests();
  m.getCurrentAccount.mockResolvedValue(ctx);
  m.requireRole.mockImplementation(m.getCurrentAccount);
  m.upload.mockResolvedValue({ data: {}, error: null });
  m.remove.mockResolvedValue({ data: [], error: null });
  m.rpc.mockImplementation(async (fn: string) =>
    fn === 'desk_bank_by_short'
      ? { data: 'RAKBANK', error: null }
      : { data: [RESULT], error: null }
  );
});

describe('POST /api/desk/intake', () => {
  it('fills empty tags from the caption and maps a NEW desk code to its bank', async () => {
    const res = await post({
      idemKey: 'up-abcdefgh',
      caption: 'NEW rak Kite LLC 123456',
      product: 'Card',
    });
    expect(res.status).toBe(201);
    const submit = m.rpc.mock.calls.find((c) => c[0] === 'intake_submit')![1];
    expect(submit).toMatchObject({
      p_actor: 'u-1',
      p_account: 'acc-1',
      p_kind: 'new_case',
      p_bank_code: 'RAKBANK',
      p_company_name: 'Kite LLC',
      p_trade_licence: '123456',
      p_product: 'Card',
      p_storage_path: null,
    });
    expect(m.upload).not.toHaveBeenCalled();
  });

  it('stores the file at intake/<item>/<sha256>.pdf before submitting', async () => {
    await post({
      idemKey: 'up-abcdefgh',
      caseRef: '1RAK1',
      kind: 'pending_doc',
      file: new File([PDF], 'licence.pdf', { type: 'application/pdf' }),
    });
    const submit = m.rpc.mock.calls.find((c) => c[0] === 'intake_submit')![1];
    expect(submit.p_storage_path).toBe(
      `intake/${submit.p_item}/${submit.p_sha256}.pdf`
    );
    expect(m.upload).toHaveBeenCalledWith(
      submit.p_storage_path,
      expect.any(Uint8Array),
      {
        contentType: 'application/pdf',
        upsert: false,
      }
    );
  });

  it('refuses a file whose bytes are not its type, before storing anything', async () => {
    const res = await post({
      idemKey: 'up-abcdefgh',
      file: new File([new Uint8Array([1, 2, 3, 4])], 'x.pdf', {
        type: 'application/pdf',
      }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'FILE_INVALID' });
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('answers 200 for a replay and maps a SQL refusal', async () => {
    m.rpc.mockResolvedValueOnce({
      data: [{ ...RESULT, replayed: true }],
      error: null,
    });
    expect((await post({ idemKey: 'up-abcdefgh' })).status).toBe(200);
    m.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '23514', hint: 'NOT_ALLOWED' },
    });
    const res = await post({ idemKey: 'up-abcdefgh' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'NOT_ALLOWED' });
  });

  const withFile = () =>
    post({
      idemKey: 'up-abcdefgh',
      file: new File([PDF], 'licence.pdf', { type: 'application/pdf' }),
    });

  it('stores nothing for someone below agent', async () => {
    m.requireRole.mockRejectedValue(new ForbiddenError('agent'));
    const res = await withFile();
    expect(res.status).toBe(403);
    expect(m.requireRole).toHaveBeenCalledWith('agent');
    expect(m.upload).not.toHaveBeenCalled();
  });

  it('drops the file of a refused or replayed upload, keeps a doubtful one', async () => {
    m.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '23514', hint: 'NOT_ALLOWED' },
    });
    await withFile();
    expect(m.remove).toHaveBeenCalledWith([m.upload.mock.calls[0][0]]);

    m.rpc.mockResolvedValueOnce({
      data: [{ ...RESULT, item_id: 'an-earlier-item', replayed: true }],
      error: null,
    });
    expect((await withFile()).status).toBe(200);
    expect(m.remove).toHaveBeenCalledTimes(2);

    // No answer: the submit may be stored, and point at the file.
    m.rpc.mockResolvedValueOnce({ data: null, error: { code: '57014' } });
    expect((await withFile()).status).toBeGreaterThanOrEqual(500);
    expect(m.remove).toHaveBeenCalledTimes(2);
  });

  it('refuses the 61st upload of a minute before reading the body', async () => {
    for (let i = 0; i < 60; i++) await post({ idemKey: 'up-abcdefgh' });
    expect((await withFile()).status).toBe(429);
    expect(m.upload).not.toHaveBeenCalled();
  });

  it('refuses a bad idempotency key and a restricted department', async () => {
    expect((await post({ idemKey: 'short' })).status).toBe(400);
    m.getCurrentAccount.mockResolvedValue({ ...ctx, salesRestricted: true });
    expect((await post({ idemKey: 'up-abcdefgh' })).status).toBe(403);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
