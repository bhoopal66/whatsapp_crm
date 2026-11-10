import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  requireApiKey: vi.fn(),
}));

vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: m.requireApiKey }));

import { forbidden } from '@/lib/api/v1/respond';
import { GET } from './route';

const params = { params: Promise.resolve({ submissionId: ' SUB-1 ' }) };
const get = () => GET(new Request('http://x'), params);

const status = {
  ready: true,
  documents: [{ docKey: 'passport', required: true, status: 'passed' }],
  build: {
    version: 2,
    merged: true,
    sha256: 'abc',
    builtAt: '2026-11-10T10:00:00Z',
    manifest: [
      { docKey: 'passport', renamedName: 'X.pdf', pages: 2, sha256: 'def' },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.requireApiKey.mockResolvedValue({
    accountId: 'acct-1',
    supabase: { rpc: m.rpc },
    keyId: 'key-1',
  });
  m.rpc.mockResolvedValue({ data: status, error: null });
});

describe('GET /api/v1/submission-groups/[ref]/case-file', () => {
  it('needs submission_groups:read and answers 403 without it', async () => {
    m.requireApiKey.mockRejectedValue(forbidden('Missing scope'));
    const res = await get();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(m.requireApiKey).toHaveBeenCalledWith(
      expect.any(Request),
      'submission_groups:read'
    );
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('returns the status json as data, scoped to the key account', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: status });
    expect(m.rpc).toHaveBeenCalledWith('case_file_status_api', {
      p_account: 'acct-1',
      p_submission_ref: 'SUB-1',
    });
  });

  it('answers an unknown ref 404 in the v1 error shape', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: {
        code: 'P0002',
        hint: 'FILE_NOT_FOUND',
        message: 'case file SUB-1 not found',
      },
    });
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'not_found', message: 'Case file not found' },
    });
  });

  it('answers any other database failure 500 without its text', async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: '42P01', message: 'relation secret_table missing' },
    });
    const res = await get();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('internal');
    expect(JSON.stringify(body)).not.toContain('secret_table');
  });
});
