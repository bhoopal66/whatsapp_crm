import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  role: vi.fn(),
  supabaseAdmin: vi.fn(),
  assembleCaseFile: vi.fn(),
  currentCaseFileBuild: vi.fn(),
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
vi.mock('@/lib/case-files/assembly', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/case-files/assembly')>()),
  assembleCaseFile: m.assembleCaseFile,
  currentCaseFileBuild: m.currentCaseFileBuild,
}));

import { CaseFilesRefusedError } from '@/lib/case-files/store';

import { GET, POST } from './route';

const C = '11111111-1111-4111-8111-111111111111';
const ctx = { params: Promise.resolve({ id: C }) };
const MANIFEST = [
  {
    position: 0,
    docKey: 'passport',
    fileId: 'f-1',
    renamedName: 'Passport.pdf',
    pages: 2,
    sha256: 'aa',
  },
];
const ASSEMBLED = {
  buildId: 'b-1',
  version: 3,
  merged: true,
  manifest: MANIFEST,
  objectPath: `cases/${C}/bundle-ff.pdf`,
  sha256: 'ff',
};
const BUILT_AT = new Date('2026-11-10T08:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.get.mockResolvedValue({ id: C, accountId: 'acct-1', contactId: 'ct-1' });
  m.role.mockResolvedValue('coordinator');
  m.supabaseAdmin.mockReturnValue(admin);
  m.currentCaseFileBuild.mockResolvedValue({
    ...ASSEMBLED,
    status: 'ready',
    builtAt: BUILT_AT,
  });
  m.assembleCaseFile.mockResolvedValue(ASSEMBLED);
});

describe('GET build', () => {
  it('answers the ready build without the object path', async () => {
    const res = await GET(new Request('http://x'), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain('objectPath');
    expect(text).not.toContain('bundle-ff.pdf');
    expect(JSON.parse(text)).toEqual({
      build: {
        buildId: 'b-1',
        version: 3,
        merged: true,
        manifest: MANIFEST,
        sha256: 'ff',
        status: 'ready',
        builtAt: BUILT_AT.toISOString(),
      },
    });
    expect(m.currentCaseFileBuild).toHaveBeenCalledWith({
      admin,
      actor: 'u-1',
      caseId: C,
    });
  });

  it('answers null with no build', async () => {
    m.currentCaseFileBuild.mockResolvedValue(null);
    const res = await GET(new Request('http://x'), ctx);
    expect(await res.json()).toEqual({ build: null });
  });

  it("is 404 for another account's case, with no service-role call", async () => {
    m.get.mockResolvedValue({ id: C, accountId: 'acct-2', contactId: 'ct-1' });
    const res = await GET(new Request('http://x'), ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(m.supabaseAdmin).not.toHaveBeenCalled();
    expect(m.currentCaseFileBuild).not.toHaveBeenCalled();
  });
});

describe('POST build', () => {
  it('assembles as the caller and answers 201 without the object path', async () => {
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.build).toMatchObject({
      buildId: 'b-1',
      version: 3,
      sha256: 'ff',
      status: 'ready',
    });
    expect(body.build).not.toHaveProperty('objectPath');
    const arg = m.assembleCaseFile.mock.calls[0][0];
    expect(arg).toMatchObject({
      admin,
      actor: 'u-1',
      caseId: C,
      deps: { storage: admin.storage },
    });
    expect(body.build.builtAt).toBe(arg.now.toISOString());
  });

  it("is 404 for another account's case, with no service-role call", async () => {
    m.get.mockResolvedValue({ id: C, accountId: 'acct-2', contactId: 'ct-1' });
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx);
    expect(res.status).toBe(404);
    expect(m.supabaseAdmin).not.toHaveBeenCalled();
    expect(m.assembleCaseFile).not.toHaveBeenCalled();
  });

  it.each([
    ['NOT_ALLOWED', 403],
    ['FILE_NOT_READY', 409],
    ['CASE_CLOSED', 409],
    ['BUILD_INVALID', 409],
  ] as const)('maps %s to %i', async (hint, status) => {
    m.assembleCaseFile.mockRejectedValue(new CaseFilesRefusedError(hint));
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx);
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(hint);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
