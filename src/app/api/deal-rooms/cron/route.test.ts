import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ reconcile: vi.fn(), db: { tag: 'admin' } }));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => h.db,
}));
vi.mock('@/lib/deal-rooms/reconcile', () => ({
  reconcileCreatingRooms: h.reconcile,
}));

import { GET } from './route';

const req = (secret?: string) =>
  new Request('http://localhost/api/deal-rooms/cron', {
    headers: secret === undefined ? {} : { 'x-cron-secret': secret },
  });

describe('GET /api/deal-rooms/cron', () => {
  beforeEach(() => {
    h.reconcile.mockReset();
    vi.stubEnv('AUTOMATION_CRON_SECRET', 's3cret');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('answers 503 when the cron secret is not configured', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', '');
    const res = await GET(req('s3cret'));
    expect(res.status).toBe(503);
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it('answers 401 for a missing or wrong secret', async () => {
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req('s3creT'))).status).toBe(401);
    expect((await GET(req('s3cret-longer'))).status).toBe(401);
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it('reconciles on the service-role client and answers its counts', async () => {
    const counts = {
      checked: 4,
      opened: 1,
      retried: 1,
      failed: 1,
      waiting: 1,
      errors: 0,
    };
    h.reconcile.mockResolvedValue(counts);
    const res = await GET(req('s3cret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...counts });
    expect(h.reconcile).toHaveBeenCalledWith(h.db);
  });

  it('answers 500 without detail when the reconcile throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.reconcile.mockRejectedValue(new Error('stuck room lookup failed: boom'));
    const res = await GET(req('s3cret'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'deal room reconcile failed' });
    log.mockRestore();
  });
});
