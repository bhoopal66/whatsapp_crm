import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  calls: [] as string[],
  rpc: vi.fn(),
  createSignedUrl: vi.fn(),
  from: vi.fn(),
  requireApiKey: vi.fn(),
}));

vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: m.requireApiKey }));

import { forbidden } from '@/lib/api/v1/respond';
import { GET } from './route';

const params = { params: Promise.resolve({ submissionId: ' SUB-1 ' }) };
const get = () => GET(new Request('http://x'), params);

const record = {
  download_id: 'dl-1',
  object_path: 'account-acct-1/builds/case-1/v2.pdf',
  sha256: 'abc',
  version: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.calls.length = 0;
  m.requireApiKey.mockResolvedValue({
    accountId: 'acct-1',
    supabase: { rpc: m.rpc, storage: { from: m.from } },
    keyId: 'key-1',
  });
  m.rpc.mockImplementation(async (fn: string) => {
    m.calls.push(fn);
    if (fn === 'case_build_download_record_api')
      return { data: [record], error: null };
    return { data: null, error: null };
  });
  m.from.mockImplementation((bucket: string) => {
    m.calls.push(`from:${bucket}`);
    return { createSignedUrl: m.createSignedUrl };
  });
  m.createSignedUrl.mockImplementation(async () => {
    m.calls.push('sign');
    return {
      data: { signedUrl: 'http://kong:8000/storage/v1/object/sign/x?token=t' },
      error: null,
    };
  });
});

describe('GET /api/v1/submission-groups/[ref]/case-file/download', () => {
  it('needs submission_groups:read and answers 403 without it', async () => {
    m.requireApiKey.mockRejectedValue(forbidden('Missing scope'));
    const res = await get();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(m.requireApiKey).toHaveBeenCalledWith(
      expect.any(Request),
      'submission_groups:read'
    );
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('records with the key id, signs, then marks issued', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(m.calls).toEqual([
      'case_build_download_record_api',
      'from:case-files',
      'sign',
      'case_file_download_issued',
    ]);
    expect(m.rpc).toHaveBeenCalledWith(
      'case_build_download_record_api',
      expect.objectContaining({
        p_api_key: 'key-1',
        p_account: 'acct-1',
        p_submission_ref: 'SUB-1',
      })
    );
    expect(m.createSignedUrl).toHaveBeenCalledWith(record.object_path, 600);
    expect(m.rpc).toHaveBeenCalledWith('case_file_download_issued', {
      p_download_id: 'dl-1',
    });
    const body = await res.json();
    expect(body.data).toMatchObject({ sha256: 'abc', version: 2 });
    expect(typeof body.data.url).toBe('string');
    expect(typeof body.data.expires_at).toBe('string');
    expect(Object.keys(body.data).sort()).toEqual([
      'expires_at',
      'sha256',
      'url',
      'version',
    ]);
  });

  it('answers an unknown ref 404 in the v1 error shape, unsigned', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0002', hint: 'FILE_NOT_FOUND', message: 'x' },
    });
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({
      error: { code: 'not_found', message: 'Case file not found' },
    });
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it('answers no current build 409 case_file_stale', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: '23514', hint: 'BUILD_STALE', message: 'x' },
    });
    const res = await get();
    expect(res.status).toBe(409);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect((await res.json()).error.code).toBe('case_file_stale');
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it('a signer failure is 500 and never marks the download issued', async () => {
    m.createSignedUrl.mockResolvedValue({
      data: null,
      error: { message: 'storage down' },
    });
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect((await res.json()).error.code).toBe('internal');
    expect(m.rpc).toHaveBeenCalledWith(
      'case_build_download_record_api',
      expect.anything()
    );
    expect(m.rpc).not.toHaveBeenCalledWith(
      'case_file_download_issued',
      expect.anything()
    );
  });

  it('answers 501 when this install cannot sign', async () => {
    m.requireApiKey.mockResolvedValue({
      accountId: 'acct-1',
      supabase: { rpc: m.rpc },
      keyId: 'key-1',
    });
    const res = await get();
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe('not_configured');
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
