import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  role: vi.fn(),
  supabaseAdmin: vi.fn(),
  getFile: vi.fn(),
  getDocument: vi.fn(),
  recordFileDownload: vi.fn(),
  markDownloadIssued: vi.fn(),
  createSignedUrl: vi.fn(),
  from: vi.fn(),
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
    getFile = m.getFile;
    getDocument = m.getDocument;
    recordFileDownload = m.recordFileDownload;
    markDownloadIssued = m.markDownloadIssued;
  },
}));

import { GET } from './route';

const C = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const F = '22222222-2222-4222-8222-222222222222';
const ctx = { params: Promise.resolve({ id: C, fileId: F }) };
const get = () => GET(new Request('http://x'), ctx);

const CHAT_URL =
  'http://localhost:8000/storage/v1/object/public/chat-media/account-1/inbound/a.pdf';
const doc = (over: Record<string, unknown>) => ({
  id: 'doc-1',
  contactId: 'ct-1',
  mediaUrl: null,
  storageBucket: null,
  storagePath: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('SUPABASE_INTERNAL_URL', 'http://localhost:8000');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://pub.example/supabase');
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.get.mockResolvedValue({ id: C, accountId: 'acct-1', contactId: 'ct-1' });
  m.role.mockResolvedValue('agent');
  m.from.mockReturnValue({ createSignedUrl: m.createSignedUrl });
  m.supabaseAdmin.mockReturnValue({ storage: { from: m.from } });
  m.getFile.mockResolvedValue({
    id: F,
    caseId: C,
    customerDocumentId: 'doc-1',
  });
  m.recordFileDownload.mockResolvedValue({
    downloadId: 'd-1',
    customerDocumentId: 'doc-1',
  });
  m.getDocument.mockResolvedValue(doc({ mediaUrl: CHAT_URL }));
  m.createSignedUrl.mockResolvedValue({
    data: {
      signedUrl:
        'http://localhost:8000/storage/v1/object/sign/case-files/cases/x/a.pdf?token=t',
    },
    error: null,
  });
});

afterEach(() => vi.unstubAllEnvs());

describe('GET files/[fileId]/download', () => {
  it('returns a chat-media document on the public origin and marks issued', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      url: 'https://pub.example/supabase/storage/v1/object/public/chat-media/account-1/inbound/a.pdf',
      expiresAt: null,
    });
    expect(m.recordFileDownload).toHaveBeenCalledWith(
      'u-1',
      F,
      expect.any(Date)
    );
    expect(m.getDocument).toHaveBeenCalledWith('doc-1');
    expect(m.createSignedUrl).not.toHaveBeenCalled();
    expect(m.markDownloadIssued).toHaveBeenCalledWith('d-1');
  });

  it('signs a case-files document for 600 s', async () => {
    m.getDocument.mockResolvedValue(
      doc({ storageBucket: 'case-files', storagePath: 'cases/x/a.pdf' })
    );
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe(
      'https://pub.example/supabase/storage/v1/object/sign/case-files/cases/x/a.pdf?token=t'
    );
    const now: Date = m.recordFileDownload.mock.calls[0][2];
    expect(body.expiresAt).toBe(
      new Date(now.getTime() + 600_000).toISOString()
    );
    expect(m.from).toHaveBeenCalledWith('case-files');
    expect(m.createSignedUrl).toHaveBeenCalledWith('cases/x/a.pdf', 600);
    expect(m.markDownloadIssued).toHaveBeenCalledWith('d-1');
  });

  it.each([
    ['another bucket', doc({ storageBucket: 'avatars', storagePath: 'a.pdf' })],
    ['an arbitrary URL', doc({ mediaUrl: 'https://evil.example/a.pdf' })],
    ['no location', doc({})],
    [
      'a case-files path with ..',
      doc({ storageBucket: 'case-files', storagePath: 'cases/../x.pdf' }),
    ],
  ])('is 404 for %s and never marks issued', async (_label, d) => {
    m.getDocument.mockResolvedValue(d);
    const res = await get();
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('FILE_NOT_FOUND');
    expect(m.createSignedUrl).not.toHaveBeenCalled();
    expect(m.markDownloadIssued).not.toHaveBeenCalled();
  });

  it('is 500 and never marks issued when signing fails', async () => {
    m.getDocument.mockResolvedValue(
      doc({ storageBucket: 'case-files', storagePath: 'cases/x/a.pdf' })
    );
    m.createSignedUrl.mockRejectedValue(new Error('down'));
    expect((await get()).status).toBe(500);
    expect(m.markDownloadIssued).not.toHaveBeenCalled();
  });

  it("is 404 for another case's file, writing no audit row", async () => {
    m.getFile.mockResolvedValue({
      id: F,
      caseId: OTHER,
      customerDocumentId: 'doc-1',
    });
    const res = await get();
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('FILE_NOT_FOUND');
    expect(m.recordFileDownload).not.toHaveBeenCalled();
    expect(m.markDownloadIssued).not.toHaveBeenCalled();
  });

  it('is 404 for a malformed file id, before any service-role call', async () => {
    const res = await GET(new Request('http://x'), {
      params: Promise.resolve({ id: C, fileId: 'nope' }),
    });
    expect(res.status).toBe(404);
    expect(m.supabaseAdmin).not.toHaveBeenCalled();
  });

  it("is 404 for another account's case, with no service-role call", async () => {
    m.get.mockResolvedValue({ id: C, accountId: 'acct-2', contactId: 'ct-1' });
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(m.supabaseAdmin).not.toHaveBeenCalled();
    expect(m.getFile).not.toHaveBeenCalled();
    expect(m.recordFileDownload).not.toHaveBeenCalled();
  });
});
