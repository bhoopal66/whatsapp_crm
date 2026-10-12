import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ tick: vi.fn(), db: { tag: 'admin' } }));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => h.db,
}));
vi.mock('@/lib/journeys/host/tick', () => ({ runJourneyTick: h.tick }));

import { GET } from './route';

const req = (secret?: string) =>
  new Request('http://localhost/api/journeys/cron', {
    headers: secret === undefined ? {} : { 'x-cron-secret': secret },
  });

describe('GET /api/journeys/cron', () => {
  beforeEach(() => {
    h.tick.mockReset();
    vi.stubEnv('AUTOMATION_CRON_SECRET', 's3cret');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('answers 503 when the cron secret is not configured', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', '');
    const res = await GET(req('s3cret'));
    expect(res.status).toBe(503);
    expect(h.tick).not.toHaveBeenCalled();
  });

  it('answers 401 for a missing or wrong secret', async () => {
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req('s3creT'))).status).toBe(401);
    expect((await GET(req('s3cret-longer'))).status).toBe(401);
    expect(h.tick).not.toHaveBeenCalled();
  });

  it('runs the tick on the service-role client and answers its counts', async () => {
    const counts = {
      accounts: 1,
      timersFired: 2,
      filesDrained: 3,
      delivered: 4,
      dropped: 0,
      errors: 0,
    };
    h.tick.mockResolvedValue(counts);
    const res = await GET(req('s3cret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...counts });
    expect(h.tick).toHaveBeenCalledWith({ db: h.db });
  });

  it('answers 500 without detail when the tick throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.tick.mockRejectedValue(new Error('journey_settings: boom'));
    const res = await GET(req('s3cret'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'journey tick failed' });
    log.mockRestore();
  });
});
