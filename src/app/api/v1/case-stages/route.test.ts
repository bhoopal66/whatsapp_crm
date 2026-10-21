import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forbidden, unauthorized } from '@/lib/api/v1/respond';

const m = vi.hoisted(() => ({ rpc: vi.fn(), requireApiKey: vi.fn() }));
vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: m.requireApiKey }));

import { GET } from './route';

const get = (qs: string) =>
  GET(new Request(`http://x/api/v1/case-stages${qs}`));

beforeEach(() => {
  vi.clearAllMocks();
  m.requireApiKey.mockResolvedValue({
    accountId: 'acct-1',
    supabase: { rpc: m.rpc },
  });
  m.rpc.mockResolvedValue({ data: ['Interested', 'Approved'], error: null });
});

describe('GET /api/v1/case-stages', () => {
  it('answers 401 and 403 from the key check, asking for the read scope', async () => {
    m.requireApiKey.mockRejectedValueOnce(unauthorized());
    expect((await get('?bank=FAB')).status).toBe(401);
    m.requireApiKey.mockRejectedValueOnce(forbidden('scope'));
    expect((await get('?bank=FAB')).status).toBe(403);
    expect(m.requireApiKey.mock.calls[0][1]).toBe('submission_groups:read');
  });

  it.each(['', '?bank=', '?bank=F', '?bank=a-b', `?bank=${'A'.repeat(33)}`])(
    'refuses %s with 400 bad_request',
    async (qs) => {
      const res = await get(qs);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('bad_request');
      expect(m.rpc).not.toHaveBeenCalled();
    }
  );

  it('returns the shape, upper-casing the bank and scoping to the key account', async () => {
    const res = await get('?bank=fab');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        bank: 'FAB',
        stages: ['Interested', 'Approved'],
        presubmission: ['Interested', 'Data collection', 'Review'],
        final: ['Approved', 'Declined', 'Withdrawn', 'Closed'],
      },
    });
    expect(m.rpc).toHaveBeenCalledWith('case_stages_for_bank', {
      p_account: 'acct-1',
      p_bank_code: 'FAB',
    });
  });
});
