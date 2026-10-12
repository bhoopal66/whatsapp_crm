import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@/lib/pbx/admin', () => ({ pbxServiceDb: () => ({}) }));
vi.mock('@/lib/pbx/housekeeping', () => ({ runPbxCron: h.run }));

import { GET } from './route';

const req = (secret?: string) =>
  new Request('http://app/api/pbx/cron', {
    headers: secret === undefined ? {} : { 'x-cron-secret': secret },
  });

beforeEach(() => {
  h.run.mockReset().mockResolvedValue({ outOfTime: [], errors: {} });
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/pbx/cron', () => {
  it('503 when AUTOMATION_CRON_SECRET is unset', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', '');
    expect((await GET(req('s3cret'))).status).toBe(503);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('401 on a missing or wrong secret', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', 's3cret');
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req('s3creX'))).status).toBe(401);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('200 with the run summary', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', 's3cret');
    const res = await GET(req('s3cret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outOfTime: [], errors: {} });
    expect(h.run).toHaveBeenCalledTimes(1);
  });
});
