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

  it('answers 200 with every event of an array stored, processed inside after()', async () => {
    const body = JSON.stringify([
      presence('1001'),
      { type: 30008, msg: { extension: '1001', status: 'busy' } },
    ]);
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, received: 2 });
    // Stored before the answer; nothing applied yet.
    expect(fake.tables.pbx_events_raw).toHaveLength(2);
    expect(fake.tables.pbx_presence ?? []).toHaveLength(0);
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

describe('POST /api/pbx/yeastar/events/[token]: storing before answering', () => {
  const pair = JSON.stringify([
    presence('1001'),
    { type: 30008, msg: { extension: '1001', status: 'busy' } },
  ]);
  /** Fails the chosen pbx_events_raw upserts, by call number from 0. */
  const failUpserts = (
    when: (n: number) => boolean,
    error: { message: string; code?: string } = { message: 'down' }
  ) => {
    let n = 0;
    const real = fake.db.from.bind(fake.db);
    h.db = {
      rpc: fake.db.rpc.bind(fake.db),
      from: (table: string) => {
        const q = real(table);
        if (table !== 'pbx_events_raw') return q;
        const upsert = q.upsert.bind(q);
        q.upsert = ((...a: Parameters<typeof upsert>) =>
          when(n++)
            ? { select: async () => ({ data: null, error }) }
            : upsert(...a)) as unknown as typeof q.upsert;
        return q;
      },
    };
    return () => n;
  };
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tries a frame that failed once more, then answers 200', async () => {
    const tries = failUpserts((n) => n === 0);
    expect((await post(pair)).status).toBe(200);
    expect(tries()).toBe(3);
    expect(fake.tables.pbx_events_raw).toHaveLength(2);
    await Promise.all(h.after.map((cb) => cb()));
    expect(fake.tables.pbx_events_raw.every((r) => r.processed_at)).toBe(true);
  });

  it('answers 503 when a frame is still not stored, and runs the others', async () => {
    // Frame 0 stored; frame 1 fails on both tries.
    failUpserts((n) => n > 0);
    expect((await post(pair)).status).toBe(503);
    await Promise.all(h.after.map((cb) => cb()));
    expect(fake.tables.pbx_events_raw).toHaveLength(1);
    expect(fake.tables.pbx_presence[0]).toMatchObject({ presence: 'away' });

    // The PBX sends it all again: only the lost frame is new.
    h.after = [];
    h.db = fake.db;
    expect((await post(pair)).status).toBe(200);
    await Promise.all(h.after.map((cb) => cb()));
    expect(fake.tables.pbx_events_raw).toHaveLength(2);
    expect(fake.tables.pbx_presence[0]).toMatchObject({ call_state: 'busy' });
  });

  it('acknowledges a frame the database can never take: a resend cannot help', async () => {
    const tries = failUpserts(() => true, { message: 'null', code: '23502' });
    expect((await post('null')).status).toBe(200);
    expect(tries()).toBe(1);
    expect(h.after).toHaveLength(0);
  });

  it('processes nothing for a redelivered frame', async () => {
    const body = JSON.stringify(presence('1001'));
    expect((await post(body)).status).toBe(200);
    h.after = [];
    expect((await post(body)).status).toBe(200);
    expect(h.after).toHaveLength(0);
    expect(fake.tables.pbx_events_raw).toHaveLength(1);
  });
});
