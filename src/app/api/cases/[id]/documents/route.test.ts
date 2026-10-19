import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  role: vi.fn(),
  checklist: vi.fn(),
  setDocStatus: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  caseStore: () => ({ get: m.get, role: m.role }),
  caseToolsStore: () => ({
    checklist: m.checklist,
    setDocStatus: m.setDocStatus,
  }),
}));

import { CaseRefusedError } from '@/lib/cases/store';

import { GET, POST } from './route';

const C = '11111111-1111-4111-8111-111111111111';
const params = () => ({ params: Promise.resolve({ id: C }) });
const post = (body: unknown) =>
  POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    params()
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.get.mockResolvedValue({ id: C, accountId: 'acct-1' });
  m.role.mockResolvedValue('agent');
  m.checklist.mockResolvedValue({
    items: [
      { docKey: 'eid', status: 'received', fileRef: 'f1' },
      { docKey: 'salary', status: null, fileRef: null },
    ],
    missing: ['salary'],
  });
  m.setDocStatus.mockResolvedValue('received');
});

describe('GET documents', () => {
  it('answers the checklist with a missing flag per item', async () => {
    const res = await GET(new Request('http://x'), params());
    expect(await res.json()).toEqual({
      items: [
        { docKey: 'eid', status: 'received', fileRef: 'f1', missing: false },
        { docKey: 'salary', status: null, fileRef: null, missing: true },
      ],
      missing: ['salary'],
    });
  });

  it("answers 404 for another account's case", async () => {
    m.get.mockResolvedValue({ id: C, accountId: 'acct-2' });
    expect((await GET(new Request('http://x'), params())).status).toBe(404);
    expect(m.checklist).not.toHaveBeenCalled();
  });
});

describe('POST documents', () => {
  it('sets the status as the caller', async () => {
    const res = await post({
      doc_key: 'eid',
      status: 'received',
      file_ref: 'store:abc.pdf',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'received' });
    expect(m.setDocStatus).toHaveBeenCalledWith({
      caseId: C,
      actor: 'u-1',
      docKey: 'eid',
      status: 'received',
      fileRef: 'store:abc.pdf',
    });
  });

  it('answers 400 on a bad shape or file_ref', async () => {
    for (const body of [
      { doc_key: 'eid', status: 'lost' },
      { doc_key: 'E ID', status: 'requested' },
      { doc_key: 'eid', status: 'received', file_ref: '../etc/passwd' },
    ])
      expect((await post(body)).status).toBe(400);
    expect(m.setDocStatus).not.toHaveBeenCalled();
  });

  it('answers 404 for role null', async () => {
    m.role.mockResolvedValue(null);
    expect((await post({ doc_key: 'eid', status: 'requested' })).status).toBe(
      404
    );
  });

  it('maps refusals to 422 with the code', async () => {
    m.setDocStatus.mockRejectedValue(new CaseRefusedError('FILE_REF_REQUIRED'));
    const res = await post({ doc_key: 'eid', status: 'received' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('FILE_REF_REQUIRED');
  });
});
