import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getCurrentAccount: vi.fn() }));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));

import { UnauthorizedError } from '@/lib/auth/account';

import { GET } from './route';

describe('GET /api/push/config', () => {
  beforeEach(() => {
    mocks.getCurrentAccount.mockResolvedValue({ userId: 'u-1' });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns the VAPID public key when push is configured', async () => {
    vi.stubEnv('VAPID_PUBLIC_KEY', 'pub');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'priv');
    vi.stubEnv('VAPID_SUBJECT', 'mailto:ops@example.com');
    expect(await (await GET()).json()).toEqual({ publicKey: 'pub' });
  });

  it('returns null when any key is missing', async () => {
    vi.stubEnv('VAPID_PUBLIC_KEY', 'pub');
    vi.stubEnv('VAPID_PRIVATE_KEY', '');
    vi.stubEnv('VAPID_SUBJECT', 'mailto:ops@example.com');
    expect(await (await GET()).json()).toEqual({ publicKey: null });
  });

  it('refuses a caller with no session', async () => {
    mocks.getCurrentAccount.mockRejectedValue(new UnauthorizedError());
    expect((await GET()).status).toBe(401);
  });
});
