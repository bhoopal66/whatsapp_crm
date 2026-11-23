import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  role: vi.fn(),
  supabaseAdmin: vi.fn(),
  attach: vi.fn(),
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
vi.mock('@/lib/case-files/intake-file', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/case-files/intake-file')>()),
  attachCustomerDocument: m.attach,
}));

import { UnauthorizedError } from '@/lib/auth/account';
import {
  CaseFilesRefusedError,
  CaseFilesStoreError,
} from '@/lib/case-files/store';

import { POST } from './route';

const C = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const FILE = { id: 'f-1', caseId: C, docKey: 'passport', status: 'failed' };

const post = (body: unknown) =>
  POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: C }) }
  );
const valid = { customerDocumentId: DOC, docKey: 'passport' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.get.mockResolvedValue({ id: C, accountId: 'acct-1', contactId: 'ct-1' });
  m.role.mockResolvedValue('coordinator');
  m.supabaseAdmin.mockReturnValue(admin);
  m.attach.mockResolvedValue(FILE);
});

describe('POST files/attach', () => {
  it('attaches as the caller and answers 201 { file }', async () => {
    const res = await post({ ...valid, expiresOn: '2031-05-01' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ file: FILE });
    expect(m.attach).toHaveBeenCalledWith({
      admin,
      actor: 'u-1',
      caseId: C,
      customerDocumentId: DOC,
      docKey: 'passport',
      expiresOn: '2031-05-01',
      deps: { storage: admin.storage },
    });
  });

  it('passes moveFrom on, and answers what the file is filed as without it', async () => {
    m.attach.mockRejectedValueOnce(
      new CaseFilesRefusedError('ALREADY_FILED_AS', 'visa')
    );
    const body = valid;
    const res = await post(body);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'ALREADY_FILED_AS',
      filedAs: 'visa',
    });
    await post({ ...body, moveFrom: 'visa' });
    expect(m.attach.mock.calls.map(([a]) => a.moveFrom)).toEqual([undefined, 'visa']);
  });

  it('is 401 unauthenticated', async () => {
    m.getCurrentAccount.mockRejectedValue(new UnauthorizedError());
    expect((await post(valid)).status).toBe(401);
    expect(m.attach).not.toHaveBeenCalled();
  });

  it("is 404 for another account's case, with no service-role call", async () => {
    m.get.mockResolvedValue({ id: C, accountId: 'acct-2' });
    expect((await post(valid)).status).toBe(404);
    expect(m.supabaseAdmin).not.toHaveBeenCalled();
    expect(m.attach).not.toHaveBeenCalled();
  });

  it.each([
    [{ customerDocumentId: 'x', docKey: 'passport' }],
    [{ customerDocumentId: DOC, docKey: '' }],
    [{ ...valid, expiresOn: '2026-02-29' }],
  ])('is 422 VALIDATION_FAILED for %o', async (body) => {
    const res = await post(body);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
    expect(m.attach).not.toHaveBeenCalled();
  });

  it('is 400 for a body that is not a JSON object', async () => {
    expect((await post([1])).status).toBe(400);
  });

  it.each([
    ['NOT_ALLOWED', 403],
    ['CASE_NOT_FOUND', 404],
    ['FILE_NOT_FOUND', 404],
    ['CASE_CLOSED', 409],
    ['FILE_STATE', 409],
    ['CHECK_MISMATCH', 409],
    ['DOC_NOT_REQUIRED', 422],
    ['FILE_INVALID', 422],
  ] as const)('maps %s to %i', async (hint, status) => {
    m.attach.mockRejectedValue(new CaseFilesRefusedError(hint));
    const res = await post(valid);
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(hint);
  });

  it('is 500 for a store failure', async () => {
    m.attach.mockRejectedValue(new CaseFilesStoreError('x', '42501'));
    const res = await post(valid);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Something went wrong' });
  });
});
