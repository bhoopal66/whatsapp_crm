import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rpc: vi.fn(), select: vi.fn() }));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: () => ({ abortSignal: () => h.rpc() }),
    from: () => ({
      select: () => ({ limit: () => ({ abortSignal: () => h.select() }) }),
    }),
  }),
}));

import { GET as metrics } from './route';
import { GET as healthz } from '../healthz/route';
import { GET as readyz } from '../readyz/route';

const TOKEN = 't'.repeat(40);
const get = (auth?: string) =>
  new Request('http://localhost/api/metrics', {
    headers: auth ? { authorization: auth } : {},
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('METRICS_TOKEN', TOKEN);
  h.rpc.mockResolvedValue({
    data: {
      rows: [],
      held: [],
      oldest_queued_age_seconds: null,
      terminal_failed: 0,
      failed: 3,
      oldest_pending_age_seconds: 90,
    },
    error: null,
  });
});

describe('GET /api/metrics', () => {
  it('is 501 without a token configured', async () => {
    vi.stubEnv('METRICS_TOKEN', '');
    const res = await metrics(get(`Bearer ${TOKEN}`));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: 'not_configured' });
  });

  it('is 401 with a missing or wrong token, before reading anything', async () => {
    for (const auth of [undefined, 'Bearer nope', `Basic ${TOKEN}`]) {
      const res = await metrics(get(auth));
      expect(res.status).toBe(401);
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('serves the text format with every family', async () => {
    const res = await metrics(get(`Bearer ${TOKEN}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'text/plain; version=0.0.4; charset=utf-8'
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    for (const family of [
      'process_uptime_seconds',
      'nodejs_eventloop_lag_p99_seconds',
      'wacrm_outbox_stats_up 1',
      'wacrm_customer_documents_stats_up 1',
      'wacrm_customer_documents_failed 3',
      'wacrm_customer_documents_oldest_pending_age_seconds 90',
      'wacrm_integration_configured',
      '# TYPE wacrm_edge_refusals_total counter',
    ]) {
      expect(body).toContain(family);
    }
    expect(body).not.toContain(TOKEN);
  });

  it('says stats_up 0 when the queue cannot be read, and still answers', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '42883' } });
    const res = await metrics(get(`Bearer ${TOKEN}`));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('wacrm_outbox_stats_up 0');
    expect(body).toContain('wacrm_customer_documents_stats_up 0');
    expect(body).not.toMatch(/^wacrm_customer_documents_failed /m);
  });
});

describe('GET /api/healthz and /api/readyz', () => {
  it('healthz answers 200 without touching the database', async () => {
    const res = healthz();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.select).not.toHaveBeenCalled();
  });

  it('readyz is 200 when the database answers, 503 otherwise, with no detail', async () => {
    h.select.mockResolvedValueOnce({ error: null });
    let res = await readyz();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    h.select.mockResolvedValueOnce({
      error: { code: 'PGRST301', message: 'secret detail' },
    });
    res = await readyz();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });

    h.select.mockRejectedValueOnce(new Error('timeout'));
    res = await readyz();
    expect(res.status).toBe(503);
  });
});
