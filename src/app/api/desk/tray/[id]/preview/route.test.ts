import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  supabaseAdmin: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  createSignedUrl: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: m.supabaseAdmin,
}));

import { GET } from './route';

const TRAY = '22222222-2222-4222-8222-222222222222';
const CHAT_URL =
  'http://localhost:8000/storage/v1/object/public/chat-media/account-1/inbound/a.jpg';
const get = () =>
  GET(new Request('http://x'), { params: Promise.resolve({ id: TRAY }) });
const doc = (over: Record<string, unknown>) => ({
  data: [
    {
      storage_bucket: null,
      storage_path: null,
      media_url: CHAT_URL,
      mime: 'image/jpeg',
      original_name: 'id.jpg',
      ...over,
    },
  ],
  error: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('SUPABASE_INTERNAL_URL', 'http://localhost:8000');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://pub.example');
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-1',
    accountId: 'acc-1',
    salesRestricted: false,
  });
  m.from.mockReturnValue({ createSignedUrl: m.createSignedUrl });
  m.supabaseAdmin.mockReturnValue({ rpc: m.rpc, storage: { from: m.from } });
  m.createSignedUrl.mockResolvedValue({
    data: {
      signedUrl:
        'http://localhost:8000/storage/v1/object/sign/case-files/docs/a.pdf?token=t',
    },
    error: null,
  });
});

describe('GET /api/desk/tray/[id]/preview', () => {
  it('serves a public chat-media document on the public origin', async () => {
    m.rpc.mockResolvedValue(doc({}));
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({
      url: 'https://pub.example/storage/v1/object/public/chat-media/account-1/inbound/a.jpg',
      expiresAt: null,
      mime: 'image/jpeg',
      name: 'id.jpg',
      kind: 'image',
    });
    expect(m.rpc).toHaveBeenCalledWith(
      'desk_tray_file_for_preview',
      expect.objectContaining({
        p_actor: 'u-1',
        p_account: 'acc-1',
        p_tray: TRAY,
      })
    );
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it('signs a case-files copy for 300 s', async () => {
    m.rpc.mockResolvedValue(
      doc({
        storage_bucket: 'case-files',
        storage_path: 'docs/a.pdf',
        mime: 'application/pdf',
        original_name: 'a.pdf',
      })
    );
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe('pdf');
    expect(typeof body.expiresAt).toBe('string');
    expect(m.createSignedUrl).toHaveBeenCalledWith('docs/a.pdf', 300);
  });

  it('hands out no arbitrary link', async () => {
    for (const over of [
      { media_url: 'https://evil.example/a.pdf' },
      { storage_bucket: 'other-bucket', storage_path: 'a.pdf' },
      { storage_bucket: 'case-files', storage_path: '../secret.pdf' },
    ]) {
      m.rpc.mockResolvedValueOnce(doc(over));
      const res = await get();
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe('FILE_NOT_FOUND');
    }
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it('answers 404 for an item the caller may not sort', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: '23514', hint: 'TRAY_NOT_FOUND', message: 'x' },
    });
    const res = await get();
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('TRAY_NOT_FOUND');
  });
});
