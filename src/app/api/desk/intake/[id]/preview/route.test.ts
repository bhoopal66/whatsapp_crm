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

const ITEM = '11111111-1111-4111-8111-111111111111';
const SHA = 'b'.repeat(64);
const PATH = `intake/${ITEM}/${SHA}.pdf`;
const SIGNED = `http://localhost:8000/storage/v1/object/sign/case-files/${PATH}?token=secret-token`;
const get = (id = ITEM) =>
  GET(new Request('http://x'), { params: Promise.resolve({ id }) });

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
  m.rpc.mockResolvedValue({
    data: [
      {
        storage_path: PATH,
        mime: 'application/pdf',
        original_name: 'licence.pdf',
        size_bytes: 1200,
      },
    ],
    error: null,
  });
  m.createSignedUrl.mockResolvedValue({
    data: { signedUrl: SIGNED },
    error: null,
  });
});

describe('GET /api/desk/intake/[id]/preview', () => {
  it('checks and audits in SQL first, then signs for 300 s, no-store', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({
      mime: 'application/pdf',
      name: 'licence.pdf',
      kind: 'pdf',
    });
    expect(body.url).toMatch(
      /^https:\/\/pub\.example\/storage\/v1\/object\/sign\//
    );
    expect(typeof body.expiresAt).toBe('string');
    expect(m.rpc).toHaveBeenCalledWith(
      'intake_file_for_preview',
      expect.objectContaining({
        p_actor: 'u-1',
        p_account: 'acc-1',
        p_item: ITEM,
      })
    );
    expect(m.from).toHaveBeenCalledWith('case-files');
    expect(m.createSignedUrl).toHaveBeenCalledWith(PATH, 300);
    expect(m.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      m.createSignedUrl.mock.invocationCallOrder[0]
    );
  });

  it('signs nothing when the SQL refuses', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: '23514', hint: 'ITEM_NOT_FOUND', message: 'x' },
    });
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect((await res.json()).code).toBe('ITEM_NOT_FOUND');
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it("never signs an object outside this item's intake folder", async () => {
    m.rpc.mockResolvedValue({
      data: [
        {
          storage_path: 'cases/other/a.pdf',
          mime: 'application/pdf',
          original_name: 'a.pdf',
        },
      ],
      error: null,
    });
    const res = await get();
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('FILE_NOT_FOUND');
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it('answers 501 when this install cannot sign', async () => {
    m.supabaseAdmin.mockReturnValue({ rpc: m.rpc });
    const res = await get();
    expect(res.status).toBe(501);
    expect((await res.json()).code).toBe('NOT_CONFIGURED');
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('logs a signing failure without any URL or token', async () => {
    m.createSignedUrl.mockResolvedValue({
      data: null,
      error: { message: `failed for ${SIGNED}` },
    });
    const res = await get();
    expect(res.status).toBe(500);
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain('secret-token');
    expect(logged).not.toContain(PATH);
  });

  it('refuses a malformed id before any call', async () => {
    const res = await get('not-a-uuid');
    expect(res.status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
