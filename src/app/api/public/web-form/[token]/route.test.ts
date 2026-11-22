import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({ rpc }),
}));

import { OPTIONS, POST } from './route';

const TOKEN = 'a'.repeat(64);
const params = (token = TOKEN) => ({ params: Promise.resolve({ token }) });

let config: unknown;
let submit: { data: unknown; error: unknown };
let allowed: boolean;

beforeEach(() => {
  rpc.mockReset();
  config = { allowed_origins: ['https://www.shop.com'] };
  submit = { data: { status: 'ok', task_created: true }, error: null };
  allowed = true;
  rpc.mockImplementation(async (name: string) => {
    if (name === 'edge_rate_check') {
      return {
        data: [{ allowed, remaining: 1, retry_after_ms: allowed ? 0 : 5000 }],
        error: null,
      };
    }
    if (name === 'web_form_public_config') return { data: config, error: null };
    if (name === 'web_form_submit') return submit;
    throw new Error(`unexpected rpc ${name}`);
  });
});

function post(
  body: string,
  headers: Record<string, string> = {},
  url = `https://crm.example.com/api/public/web-form/${TOKEN}`
) {
  return new Request(url, { method: 'POST', body, headers });
}

const JSON_TYPE = { 'content-type': 'application/json' };
const FORM_TYPE = { 'content-type': 'application/x-www-form-urlencoded' };
const submitCalls = () =>
  rpc.mock.calls.filter(([name]) => name === 'web_form_submit');

describe('POST /api/public/web-form/[token]', () => {
  it('stores a JSON lead from a listed site and echoes CORS', async () => {
    const res = await POST(
      post(JSON.stringify({ name: 'Sara', phone: '+971 50 123 4567' }), {
        ...JSON_TYPE,
        origin: 'https://www.shop.com',
      }),
      params()
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://www.shop.com'
    );
    expect(submitCalls()).toHaveLength(1);
    expect(submitCalls()[0][1]).toMatchObject({
      p_token: TOKEN,
      p_name: 'Sara',
      p_phone: '971501234567',
    });
  });

  it('redirects a plain HTML form back to the hosted page', async () => {
    const res = await POST(
      post('name=Sara&phone=%2B971501234567', {
        ...FORM_TYPE,
        origin: 'https://crm.example.com',
      }),
      params()
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/f/${TOKEN}?sent=1`);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses an unlisted site with 403 and stores nothing', async () => {
    const res = await POST(
      post(JSON.stringify({ phone: '971501234567' }), {
        ...JSON_TYPE,
        origin: 'https://evil.example',
      }),
      params()
    );
    expect(res.status).toBe(403);
    // No Origin at all while a list is set: refused too.
    const bare = await POST(
      post(JSON.stringify({ phone: '971501234567' }), JSON_TYPE),
      params()
    );
    expect(bare.status).toBe(403);
    expect(submitCalls()).toHaveLength(0);
  });

  it('answers the honeypot as success and stores nothing', async () => {
    config = { allowed_origins: [] };
    const ok = await POST(
      post(JSON.stringify({ phone: '971501234567', website: 'x' }), JSON_TYPE),
      params()
    );
    expect(ok.status).toBe(200);
    expect(submitCalls()).toHaveLength(0);
  });

  it('answers 422 for a bad phone, 404 alike for unknown and off', async () => {
    config = { allowed_origins: [] };
    const bad = await POST(
      post(JSON.stringify({ phone: '050 123 4567' }), JSON_TYPE),
      params()
    );
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ error: 'bad_phone', field: 'phone' });

    config = null;
    const off = await POST(
      post(JSON.stringify({ phone: '971501234567' }), JSON_TYPE),
      params()
    );
    expect(off.status).toBe(404);
    const malformed = await POST(post('{}', JSON_TYPE), params('nope'));
    expect(malformed.status).toBe(404);
    expect(await off.json()).toEqual(await malformed.json());
  });

  it('refuses a big body, an unknown type and a rate-limited client', async () => {
    config = { allowed_origins: [] };
    const big = await POST(
      post(
        JSON.stringify({ phone: '971501234567', message: 'x'.repeat(9000) }),
        JSON_TYPE
      ),
      params()
    );
    expect(big.status).toBe(413);
    const type = await POST(
      post('a', { 'content-type': 'text/plain' }),
      params()
    );
    expect(type.status).toBe(415);
    allowed = false;
    const limited = await POST(
      post(JSON.stringify({ phone: '971501234567' }), JSON_TYPE),
      params()
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('5');
  });
});

describe('OPTIONS /api/public/web-form/[token]', () => {
  it('allows a listed site only', async () => {
    const ok = await OPTIONS(
      new Request(`https://crm.example.com/api/public/web-form/${TOKEN}`, {
        method: 'OPTIONS',
        headers: { origin: 'https://www.shop.com' },
      }),
      params()
    );
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(
      'https://www.shop.com'
    );
    const no = await OPTIONS(
      new Request(`https://crm.example.com/api/public/web-form/${TOKEN}`, {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example' },
      }),
      params()
    );
    expect(no.status).toBe(403);
  });
});
