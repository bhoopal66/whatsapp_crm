import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  role: vi.fn(),
  supabaseAdmin: vi.fn(),
  getFile: vi.fn(),
  classify: vi.fn(),
}));

const admin = { storage: { tag: 'storage' } };

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  caseStore: () => ({ get: m.get, role: m.role }),
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: m.supabaseAdmin,
}));
vi.mock('@/lib/case-files/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/case-files/store')>()),
  CaseFilesStore: class {
    constructor(readonly db: unknown) {}
    getFile = m.getFile;
  },
}));
vi.mock('@/lib/case-files/intake-file', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/case-files/intake-file')>()),
  classifyAndCheck: m.classify,
}));

import { UnauthorizedError } from '@/lib/auth/account';
import { CaseFilesRefusedError } from '@/lib/case-files/store';

import { POST } from './route';

const C = '11111111-1111-4111-8111-111111111111';
const F = '33333333-3333-4333-8333-333333333333';
const RESULT = {
  fileId: F,
  status: 'passed',
  classifySeq: 2,
  version: 1,
  renamedName: 'Passport_v1.pdf',
  checks: [{ name: 'mime', ok: true }],
  pages: 1,
};

const post = (body: unknown, fileId = F) =>
  POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: C, fileId }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.get.mockResolvedValue({ id: C, accountId: 'acct-1', contactId: 'ct-1' });
  m.role.mockResolvedValue('agent');
  m.supabaseAdmin.mockReturnValue(admin);
  m.getFile.mockResolvedValue({ id: F, caseId: C });
  m.classify.mockResolvedValue(RESULT);
});

describe('POST files/[fileId]/classify', () => {
  it("classifies with today's Dubai date and answers 200 { result }", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T22:30:00Z'));
    const res = await post({ docKey: 'passport', expiresOn: '2030-01-01' });
    vi.useRealTimers();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: RESULT });
    expect(m.getFile).toHaveBeenCalledWith(F);
    expect(m.classify).toHaveBeenCalledWith({
      admin,
      actor: 'u-1',
      fileId: F,
      docKey: 'passport',
      expiresOn: '2030-01-01',
      // 22:30 UTC is already the 11th in Dubai.
      today: '2026-11-11',
      deps: { storage: admin.storage },
    });
  });

  it('is 401 unauthenticated', async () => {
    m.getCurrentAccount.mockRejectedValue(new UnauthorizedError());
    expect((await post({ docKey: 'passport' })).status).toBe(401);
  });

  it("is 404 for another account's case, with no service-role call", async () => {
    m.get.mockResolvedValue({ id: C, accountId: 'acct-2' });
    expect((await post({ docKey: 'passport' })).status).toBe(404);
    expect(m.supabaseAdmin).not.toHaveBeenCalled();
    expect(m.getFile).not.toHaveBeenCalled();
    expect(m.classify).not.toHaveBeenCalled();
  });

  it("is 404 FILE_NOT_FOUND for another case's file, and classifies nothing", async () => {
    m.getFile.mockResolvedValue({
      id: F,
      caseId: '44444444-4444-4444-8444-444444444444',
    });
    const res = await post({ docKey: 'passport' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'File not found',
      code: 'FILE_NOT_FOUND',
    });
    expect(m.classify).not.toHaveBeenCalled();
  });

  it('answers an unknown file exactly as another case’s file', async () => {
    m.getFile.mockResolvedValue(null);
    const res = await post({ docKey: 'passport' });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('FILE_NOT_FOUND');
  });

  it('is 404 for a non-uuid file id, before any lookup', async () => {
    expect((await post({ docKey: 'passport' }, 'abc')).status).toBe(404);
    expect(m.getFile).not.toHaveBeenCalled();
  });

  it('is 422 without a docKey', async () => {
    const res = await post({});
    expect(res.status).toBe(422);
    expect(m.getFile).not.toHaveBeenCalled();
  });

  it.each([
    ['NOT_ALLOWED', 403],
    ['CHECK_MISMATCH', 409],
    ['FILE_STATE', 409],
    ['CASE_CLOSED', 409],
    ['DOC_NOT_REQUIRED', 422],
    ['CHECKS_INVALID', 422],
    ['VALIDATION_FAILED', 422],
  ] as const)('maps %s to %i', async (hint, status) => {
    m.classify.mockRejectedValue(new CaseFilesRefusedError(hint));
    const res = await post({ docKey: 'passport' });
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(hint);
  });
});
