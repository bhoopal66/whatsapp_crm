import { describe, expect, it, vi } from 'vitest';

const getNotificationByKey = vi.fn();
vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async () => ({ supabase: {}, accountId: 'acct' }),
}));
vi.mock('@/lib/compass/notify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/compass/notify')>()),
  getNotificationByKey: (...args: unknown[]) => getNotificationByKey(...args),
}));

import { NotifyError } from '@/lib/compass/notify';
import { GET } from './route';

const get = () =>
  GET(new Request('http://x/api/v1/compass/notifications/k'), {
    params: Promise.resolve({ key: 'k' }),
  });

describe('GET /api/v1/compass/notifications/{key}', () => {
  it('404 for a key nobody sent', async () => {
    getNotificationByKey.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });

  it('503, not 404, when the row cannot be read', async () => {
    getNotificationByKey.mockRejectedValue(
      new NotifyError('notification_lookup_failed', 'x', 503)
    );
    const res = await get();
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('notification_lookup_failed');
  });
});
