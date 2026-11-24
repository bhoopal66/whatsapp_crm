import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
  upload: vi.fn(),
  read: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({
    rpc: m.rpc,
    storage: { from: () => ({ upload: m.upload, download: vi.fn() }) },
  }),
}));
vi.mock('@/lib/case-files/bytes', () => ({ readDocumentBytes: m.read }));

import { POST } from './route';

const TRAY = '11111111-1111-4111-8111-111111111111';
const CASE = '22222222-2222-4222-8222-222222222222';
const ctx = { userId: 'u-1', accountId: 'acc-1', salesRestricted: false };
const post = (body: unknown) =>
  new Request('http://x', { method: 'POST', body: JSON.stringify(body) });
const params = { params: Promise.resolve({ id: TRAY }) };

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue(ctx);
  m.upload.mockResolvedValue({ error: null });
  m.read.mockResolvedValue(new TextEncoder().encode('%PDF-1.4 x'));
});

describe('POST /api/desk/tray/[id]/file', () => {
  it("files the sender's own document in one call", async () => {
    m.rpc.mockResolvedValueOnce({
      data: [{ outcome: 'filed', case_number: 'TC-26-00001-RAK' }],
      error: null,
    });
    const res = await POST(post({ caseId: CASE }), params);
    expect(await res.json()).toEqual({
      outcome: 'filed',
      caseNumber: 'TC-26-00001-RAK',
    });
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc.mock.calls[0]![1]).toMatchObject({
      p_actor: 'u-1',
      p_account: 'acc-1',
      p_tray: TRAY,
      p_case: CASE,
      p_confirm_company: null,
    });
  });

  it("copies another person's document through the intake, then resolves the item", async () => {
    m.rpc
      .mockResolvedValueOnce({
        data: [
          {
            outcome: 'needs_copy',
            case_number: 'TC-26-00001-RAK',
            media_url: 'https://x/storage/v1/object/public/chat-media/a.pdf',
            mime: 'application/pdf',
            original_name: 'a.pdf',
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          { item_id: TRAY, state: 'filed', case_id: CASE, replayed: false },
        ],
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(
      post({ caseId: CASE, confirmCompany: 'Kite' }),
      params
    );
    expect(res.status).toBe(200);
    expect(m.rpc.mock.calls.map((c) => c[0])).toEqual([
      'desk_tray_file',
      'desk_whatsapp_intake',
      'desk_tray_resolve',
    ]);
    expect(m.rpc.mock.calls[1]![1]).toMatchObject({
      p_actor: 'u-1',
      p_item: TRAY,
      p_idem_key: `tray:${TRAY}`,
      p_kind: 'pending_doc',
      p_case_ref: 'TC-26-00001-RAK',
    });
    expect(m.rpc.mock.calls[2]![1]).toMatchObject({
      p_tray: TRAY,
      p_case: CASE,
      p_item: TRAY,
    });
    expect(m.upload).toHaveBeenCalledTimes(1);
  });

  it('says so when the copy waits in the queue, before or after copying', async () => {
    m.rpc.mockResolvedValueOnce({
      data: [{ outcome: 'waiting' }],
      error: null,
    });
    let res = await POST(post({ caseId: CASE }), params);
    expect(await res.json()).toEqual({ outcome: 'waiting', caseNumber: null });
    expect(m.rpc).toHaveBeenCalledTimes(1);
    m.rpc
      .mockResolvedValueOnce({
        data: [
          {
            outcome: 'needs_copy',
            case_number: 'TC-26-00001-RAK',
            media_url: 'https://x/a.pdf',
            mime: 'application/pdf',
            original_name: 'a.pdf',
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ item_id: TRAY, state: 'untagged' }],
        error: null,
      });
    res = await POST(post({ caseId: CASE }), params);
    expect((await res.json()).outcome).toBe('waiting');
    expect(m.rpc).toHaveBeenCalledTimes(3);
  });

  it('maps CONFIRM_COMPANY and needs a case id', async () => {
    m.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '23514', hint: 'CONFIRM_COMPANY', message: 'x' },
    });
    let res = await POST(post({ caseId: CASE }), params);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('CONFIRM_COMPANY');
    res = await POST(post({}), params);
    expect(res.status).toBe(400);
  });
});
