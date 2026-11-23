import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  role: vi.fn(),
  supabaseAdmin: vi.fn(),
  listFiles: vi.fn(),
  fileReady: vi.fn(),
  specRows: vi.fn(),
  uploadStaffFile: vi.fn(),
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
    listFiles = m.listFiles;
    fileReady = m.fileReady;
    specRows = m.specRows;
  },
}));
vi.mock('@/lib/case-files/intake-file', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/case-files/intake-file')>()),
  uploadStaffFile: m.uploadStaffFile,
}));

import { UnauthorizedError } from '@/lib/auth/account';
import { CaseFilesRefusedError } from '@/lib/case-files/store';

import { GET, POST } from './route';

const C = '11111111-1111-4111-8111-111111111111';
const ctx = { params: Promise.resolve({ id: C }) };
const FILE = { id: 'f-1', caseId: C, docKey: 'passport', status: 'passed' };

const get = () => GET(new Request('http://x'), ctx);

function uploadRequest(fields: Record<string, string | File>): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request('http://x', { method: 'POST', body: form });
}

/** A request whose body is never meant to be read. */
function fakeRequest(headers: Record<string, string>, form?: FormData) {
  const formData = vi.fn(async () => form ?? new FormData());
  return {
    request: { headers: new Headers(headers), formData } as unknown as Request,
    formData,
  };
}

const pdf = (size = 4) =>
  new File([new Uint8Array(size)], 'id card.pdf', {
    type: 'application/pdf',
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.get.mockResolvedValue({ id: C, accountId: 'acct-1', contactId: 'ct-1' });
  m.role.mockResolvedValue('agent');
  m.supabaseAdmin.mockReturnValue(admin);
  m.listFiles.mockResolvedValue([FILE]);
  m.fileReady.mockResolvedValue(true);
  m.specRows.mockResolvedValue([{ docKey: 'passport', required: true }]);
  m.uploadStaffFile.mockResolvedValue(FILE);
});

describe('GET files', () => {
  it('answers files, ready and spec for the case', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      files: [FILE],
      ready: true,
      spec: [{ docKey: 'passport', required: true }],
    });
    expect(m.listFiles).toHaveBeenCalledWith(C);
    expect(m.fileReady).toHaveBeenCalledWith(C);
    expect(m.specRows).toHaveBeenCalledWith(C);
  });

  it('is 401 unauthenticated', async () => {
    m.getCurrentAccount.mockRejectedValue(new UnauthorizedError());
    expect((await get()).status).toBe(401);
    expect(m.supabaseAdmin).not.toHaveBeenCalled();
  });

  it("is 404 for another account's case, with no service-role call", async () => {
    m.get.mockResolvedValue({ id: C, accountId: 'acct-2', contactId: 'ct-1' });
    const res = await get();
    expect(res.status).toBe(404);
    expect(m.role).not.toHaveBeenCalled();
    expect(m.supabaseAdmin).not.toHaveBeenCalled();
    expect(m.listFiles).not.toHaveBeenCalled();
  });

  it('is 404 for a case the caller cannot read', async () => {
    m.role.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    expect(m.supabaseAdmin).not.toHaveBeenCalled();
  });

  it('maps a refusal and hides a store failure', async () => {
    m.specRows.mockRejectedValue(new CaseFilesRefusedError('CASE_NOT_FOUND'));
    const res = await get();
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('CASE_NOT_FOUND');
  });
});

describe('POST files (upload)', () => {
  it('uploads with the account and contact from the tenancy load', async () => {
    const res = await POST(
      uploadRequest({
        file: pdf(),
        docKey: 'passport',
        expiresOn: '2030-01-01',
      }),
      ctx
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ file: FILE });
    expect(m.uploadStaffFile).toHaveBeenCalledTimes(1);
    const arg = m.uploadStaffFile.mock.calls[0][0];
    expect(arg).toMatchObject({
      admin,
      actor: 'u-1',
      caseId: C,
      accountId: 'acct-1',
      contactId: 'ct-1',
      docKey: 'passport',
      expiresOn: '2030-01-01',
      deps: { storage: admin.storage },
    });
    expect(arg.file.mime).toBe('application/pdf');
    expect(arg.file.originalName).toBe('id card.pdf');
    expect(arg.file.bytes).toBeInstanceOf(Uint8Array);
    expect(arg.file.bytes.byteLength).toBe(4);
  });

  it('passes moveFrom on, and answers what the file is filed as without it', async () => {
    m.uploadStaffFile.mockRejectedValueOnce(
      new CaseFilesRefusedError('ALREADY_FILED_AS', 'visa')
    );
    const fields = { file: pdf(), docKey: 'passport' };
    const res = await POST(uploadRequest(fields), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'ALREADY_FILED_AS',
      filedAs: 'visa',
    });
    await POST(uploadRequest({ ...fields, moveFrom: 'visa' }), ctx);
    expect(m.uploadStaffFile.mock.calls.map(([a]) => a.moveFrom)).toEqual([
      undefined,
      'visa',
    ]);
  });

  it('is 413 above 15 MiB of Content-Length, without reading the body', async () => {
    const { request, formData } = fakeRequest({
      'content-length': String(15 * 1024 * 1024 + 1),
    });
    const res = await POST(request, ctx);
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('FILE_TOO_LARGE');
    expect(formData).not.toHaveBeenCalled();
    expect(m.uploadStaffFile).not.toHaveBeenCalled();
  });

  it('is 413 for a file part above 10 MiB', async () => {
    const form = new FormData();
    form.set('file', pdf(10 * 1024 * 1024 + 1));
    const { request } = fakeRequest({}, form);
    const res = await POST(request, ctx);
    expect(res.status).toBe(413);
    expect(m.uploadStaffFile).not.toHaveBeenCalled();
  });

  it('is 400 without a file part', async () => {
    const res = await POST(uploadRequest({ docKey: 'passport' }), ctx);
    expect(res.status).toBe(400);
    expect(m.uploadStaffFile).not.toHaveBeenCalled();
  });

  it('is 422 for a bad expiresOn', async () => {
    const res = await POST(
      uploadRequest({ file: pdf(), expiresOn: '2026-02-30' }),
      ctx
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('is 409 NO_CONTACT for a case with no contact', async () => {
    m.get.mockResolvedValue({ id: C, accountId: 'acct-1', contactId: null });
    const res = await POST(uploadRequest({ file: pdf() }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NO_CONTACT');
    expect(m.uploadStaffFile).not.toHaveBeenCalled();
  });

  it('is 401 unauthenticated', async () => {
    m.getCurrentAccount.mockRejectedValue(new UnauthorizedError());
    expect((await POST(uploadRequest({ file: pdf() }), ctx)).status).toBe(401);
  });

  it("is 404 for another account's case, with no service-role call", async () => {
    m.get.mockResolvedValue({ id: C, accountId: 'acct-2', contactId: 'ct-1' });
    const { request, formData } = fakeRequest({});
    expect((await POST(request, ctx)).status).toBe(404);
    expect(formData).not.toHaveBeenCalled();
    expect(m.supabaseAdmin).not.toHaveBeenCalled();
    expect(m.uploadStaffFile).not.toHaveBeenCalled();
  });

  it.each([
    ['NOT_ALLOWED', 403],
    ['CASE_CLOSED', 409],
    ['MIME_NOT_ALLOWED', 422],
    ['FILE_TOO_LARGE', 413],
    ['DOC_NOT_REQUIRED', 422],
  ] as const)('maps %s to %i', async (hint, status) => {
    m.uploadStaffFile.mockRejectedValue(new CaseFilesRefusedError(hint));
    const res = await POST(uploadRequest({ file: pdf() }), ctx);
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(hint);
  });
});
