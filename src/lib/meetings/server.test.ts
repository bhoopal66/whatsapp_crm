import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getCurrentAccount: vi.fn() }));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));

import { ForbiddenError } from '@/lib/auth/account';

import { requireMeetingsUser, sfuErrorResponse } from './server';
import { SfuError } from './sfu';

describe('requireMeetingsUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a bank guest', async () => {
    mocks.getCurrentAccount.mockResolvedValue({ role: 'bank_guest' });
    await expect(requireMeetingsUser()).rejects.toBeInstanceOf(ForbiddenError);
  });

  // A guest has no current_account_id(), so getCurrentAccount refuses
  // before the role check, in wording that reads as a broken login.
  it('words a guest’s refusal as staff only, keeping other refusals', async () => {
    mocks.getCurrentAccount.mockRejectedValueOnce(
      new ForbiddenError('Profile is not linked to an account')
    );
    await expect(requireMeetingsUser()).rejects.toThrow(
      'Video meetings are for staff only'
    );
    mocks.getCurrentAccount.mockResolvedValueOnce({ role: 'bank_guest' });
    await expect(requireMeetingsUser()).rejects.toThrow(
      'Video meetings are for staff only'
    );
    mocks.getCurrentAccount.mockRejectedValueOnce(
      new ForbiddenError('Account deactivated')
    );
    await expect(requireMeetingsUser()).rejects.toThrow('Account deactivated');
  });

  it('lets every staff role through, viewer included', async () => {
    mocks.getCurrentAccount.mockResolvedValue({ role: 'viewer', userId: 'u' });
    await expect(requireMeetingsUser()).resolves.toMatchObject({
      userId: 'u',
    });
  });
});

describe('sfuErrorResponse', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('never passes Cloudflare’s own 401 through', async () => {
    const res = sfuErrorResponse(new SfuError('x', 401, 'unauthorized'));
    expect(res?.status).toBe(502);
  });

  it('answers 504 on a timeout and 503 when unconfigured', async () => {
    expect(sfuErrorResponse(new SfuError('x', 504, 'timeout'))?.status).toBe(
      504
    );
    const res = sfuErrorResponse(new SfuError('x', 503, 'not_configured'));
    expect(res?.status).toBe(503);
    expect(await res?.json()).toEqual({ error: 'meetings_not_configured' });
  });

  it('answers 410, not 502, when the Cloudflare session is already gone', async () => {
    const res = sfuErrorResponse(new SfuError('x', 410, 'session_error'));
    expect(res?.status).toBe(410);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('leaves anything else to the caller', () => {
    expect(sfuErrorResponse(new Error('x'))).toBeNull();
  });
});
