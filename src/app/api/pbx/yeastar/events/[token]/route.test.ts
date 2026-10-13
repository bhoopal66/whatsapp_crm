import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';
import { encrypt } from '@/lib/whatsapp/encryption';

const h = vi.hoisted(() => ({
  db: null as unknown,
  after: [] as (() => Promise<void> | void)[],
}));
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (cb: () => Promise<void>) => void h.after.push(cb),
}));
vi.mock('@/lib/pbx/admin', async (orig) => ({
  ...(await orig<typeof import('@/lib/pbx/admin')>()),
  pbxServiceDb: () => h.db,
}));

import { POST } from './route';

const TOKEN = 'a'.repeat(64);
const SECRET = 'S'.repeat(32);
let fake: FakeDb;
const sign = (body: string, secret = SECRET) =>
  crypto.createHmac('sha256', secret).update(body).digest('base64');
const post = (body: string, sig: string | null = sign(body), token = TOKEN) =>
  POST(
    new Request(`https://crm.example.com/api/pbx/yeastar/events/${token}`, {
      method: 'POST',
      body,
      headers: {
        ...(sig ? { 'x-signature': sig } : {}),
        'cf-connecting-ip': '1.2.3.4',
      },
    }),
    { params: Promise.resolve({ token }) }
  );
const presence = (ext: string) => ({
  type: 30009,
  msg: { extension: ext, status: 'away' },
});

beforeEach(() => {
  h.after = [];
  fake = createFakeDb(
    {
      pbx_connections: [
        {
          id: 'c1',
          account_id: 'acc',
          status: 'unknown',
          webhook_path_token: TOKEN,
        },
      ],
      pbx_connection_secrets: [
        { connection_id: 'c1', webhook_secret_enc: encrypt(SECRET) },
      ],
      pbx_extensions: [
        {
          connection_id: 'c1',
          extension: '1001',
          account_id: 'acc',
          user_id: 'u1',
          presence_monitor: true,
        },
      ],
    },
    {
      edge_rate_check: () => ({
        data: [{ allowed: true, remaining: 9, retry_after_ms: 0 }],
        error: null,
      }),
    }
  );
  h.db = fake.db;
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/pbx/yeastar/events/[token]', () => {
  it('404s an unknown token', async () => {
    const body = JSON.stringify(presence('1001'));
    expect((await post(body, sign(body), 'b'.repeat(64))).status).toBe(404);
    expect((await post(body, sign(body), 'short')).status).toBe(404);
  });

  it('401s a bad or missing signature, and a connection with no secret', async () => {
    const body = JSON.stringify(presence('1001'));
    expect((await post(body, sign(body, 'T'.repeat(32)))).status).toBe(401);
    expect((await post(body, null)).status).toBe(401);
    fake.tables.pbx_connection_secrets[0].webhook_secret_enc = null;
    expect((await post(body)).status).toBe(401);
    expect(h.after).toHaveLength(0);
  });

  it('answers 200 and processes every event of an array inside after()', async () => {
    const body = JSON.stringify([
      presence('1001'),
      { type: 30008, msg: { extension: '1001', status: 'busy' } },
    ]);
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, received: 2 });
    expect(fake.tables.pbx_events_raw ?? []).toHaveLength(0);
    await Promise.all(h.after.map((cb) => cb()));
    expect(fake.tables.pbx_events_raw).toHaveLength(2);
    expect(fake.tables.pbx_presence[0]).toMatchObject({
      presence: 'away',
      call_state: 'busy',
    });
    // Settings → Phone system names the path that carried the latest event.
    expect(fake.tables.pbx_connections[0].last_event_via).toBe('webhook');
  });

  it('refuses a sender outside PBX_WEBHOOK_ALLOWED_IPS', async () => {
    vi.stubEnv('EDGE_CLIENT_IP_HEADER', 'cf-connecting-ip');
    vi.stubEnv('PBX_WEBHOOK_ALLOWED_IPS', '9.9.9.9, 8.8.8.8');
    const body = JSON.stringify(presence('1001'));
    expect((await post(body)).status).toBe(403);
    vi.stubEnv('PBX_WEBHOOK_ALLOWED_IPS', '9.9.9.9,1.2.3.4');
    expect((await post(body)).status).toBe(200);
  });
});
