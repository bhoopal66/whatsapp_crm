import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  role: vi.fn(),
  supabaseAdmin: vi.fn(),
  recordBuildDownload: vi.fn(),
  markDownloadIssued: vi.fn(),
  createSignedUrl: vi.fn(),
  from: vi.fn(),
  order: [] as string[],
}));

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
    recordBuildDownload = m.recordBuildDownload;
    markDownloadIssued = m.markDownloadIssued;
  },
}));

import { CaseFilesRefusedError } from '@/lib/case-files/store';

import { GET } from './route';

const C = '11111111-1111-4111-8111-111111111111';
const ctx = { params: Promise.resolve({ id: C }) };
const PATH = `cases/${C}/bundle-ff.pdf`;
const get = () => GET(new Request('http://x'), ctx);

beforeEach(() => {
  vi.clearAllMocks();
  m.order.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('SUPABASE_INTERNAL_URL', 'http://localhost:8000');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://pub.example/supabase');
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.get.mockResolvedValue({ id: C, accountId: 'acct-1', contactId: 'ct-1' });
  m.role.mockResolvedValue('agent');
  m.from.mockReturnValue({ createSignedUrl: m.createSignedUrl });
  m.supabaseAdmin.mockReturnValue({ storage: { from: m.from } });
  m.recordBuildDownload.mockImplementation(async () => {
    m.order.push('record');
    return { downloadId: 'd-1', objectPath: PATH, sha256: 'ff', version: 3 };
  });
  m.createSignedUrl.mockImplementation(async () => {
    m.order.push('sign');
    return {
      data: {
        signedUrl: `http://localhost:8000/storage/v1/object/sign/case-files/${PATH}?token=t`,
      },
      error: null,
    };
  });
  m.markDownloadIssued.mockImplementation(async () => {
    m.order.push('issued');
  });
});

afterEach(() => vi.unstubAllEnvs());

describe('GET build/download', () => {
  it('records, signs for 600 s on the public origin, then marks issued', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({
      url: `https://pub.example/supabase/storage/v1/object/sign/case-files/${PATH}?token=t`,
      sha256: 'ff',
      version: 3,
    });
    expect(m.order).toEqual(['record', 'sign', 'issued']);
    expect(m.from).toHaveBeenCalledWith('case-files');
    expect(m.createSignedUrl).toHaveBeenCalledWith(PATH, 600);
    expect(m.recordBuildDownload).toHaveBeenCalledWith(
      'u-1',
      C,
      expect.any(Date)
    );
    const now: Date = m.recordBuildDownload.mock.calls[0][2];
    expect(body.expiresAt).toBe(
      new Date(now.getTime() + 600_000).toISOString()
    );
    expect(m.markDownloadIssued).toHaveBeenCalledWith('d-1');
  });

  it('is 500 and never marks issued when signing fails', async () => {
    m.createSignedUrl.mockResolvedValue({
      data: null,
      error: { message: 'boom' },
    });
    const res = await get();
    expect(res.status).toBe(500);
    expect(m.recordBuildDownload).toHaveBeenCalledTimes(1);
    expect(m.markDownloadIssued).not.toHaveBeenCalled();
  });

  it('maps BUILD_STALE to 409 and FILE_NOT_FOUND to 404', async () => {
    m.recordBuildDownload.mockRejectedValueOnce(
      new CaseFilesRefusedError('BUILD_STALE')
    );
    expect((await get()).status).toBe(409);
    m.recordBuildDownload.mockRejectedValueOnce(
      new CaseFilesRefusedError('FILE_NOT_FOUND')
    );
    expect((await get()).status).toBe(404);
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it('is 501 NOT_CONFIGURED with no storage signer, writing nothing', async () => {
    m.supabaseAdmin.mockReturnValue({});
    const res = await get();
    expect(res.status).toBe(501);
    expect((await res.json()).code).toBe('NOT_CONFIGURED');
    expect(m.recordBuildDownload).not.toHaveBeenCalled();
  });

  it("is 404 for another account's case, with no service-role call", async () => {
    m.get.mockResolvedValue({ id: C, accountId: 'acct-2', contactId: 'ct-1' });
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(m.supabaseAdmin).not.toHaveBeenCalled();
    expect(m.recordBuildDownload).not.toHaveBeenCalled();
  });
});
