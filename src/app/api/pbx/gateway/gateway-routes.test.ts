import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';
import { cdrRecordToEventFrame } from '@/lib/pbx/gateway';
import { cdrRecordToCallEnd } from '@/lib/pbx/yeastar/cdr';
import { parseYeastarEvent } from '@/lib/pbx/yeastar/events';
import { CDR_SEARCH_OK } from '@/lib/pbx/yeastar/__tests__/fixtures';

const h = vi.hoisted(() => ({
  db: null as unknown,
  searchCdr: vi.fn(),
  getAccessToken: vi.fn(async () => 'TOKEN-abc'),
}));
vi.mock('@/lib/pbx/admin', async (orig) => ({
  ...(await orig<typeof import('@/lib/pbx/admin')>()),
  pbxServiceDb: () => h.db,
}));
vi.mock('@/lib/pbx/connection', async (orig) => ({
  ...(await orig<typeof import('@/lib/pbx/connection')>()),
  pbxApiFor: async (_db: unknown, id: string) => ({
    connection: { id, baseUrl: 'https://pbx.example.com' },
    tokens: { getAccessToken: h.getAccessToken, invalidate: vi.fn() },
    api: { searchCdr: h.searchCdr },
  }),
}));

import { POST as backfill } from './backfill/route';
import { POST as events } from './events/route';
import { POST as session } from './session/route';

const SECRET = 'g'.repeat(40);
let fake: FakeDb;
const req = (path: string, body: string, secret: string | null = SECRET) =>
  new Request(`http://app/api/pbx/gateway/${path}`, {
    method: 'POST',
    body,
    headers: secret ? { 'x-gateway-secret': secret } : {},
  });

beforeEach(() => {
  vi.stubEnv('PBX_GATEWAY_SECRET', SECRET);
  vi.stubEnv('PBX_CONNECTION_ID', '');
  fake = createFakeDb({
    pbx_connections: [
      { id: 'c1', account_id: 'acc', status: 'unknown', created_at: '1' },
    ],
    pbx_connection_secrets: [
      { connection_id: 'c1', client_secret_enc: 'ENC-SECRET-VALUE' },
    ],
  });
  h.db = fake.db;
  h.searchCdr.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('gateway auth', () => {
  it('503 when PBX_GATEWAY_SECRET is unset, 401 on a missing or wrong secret', async () => {
    expect((await session(req('session', '', null))).status).toBe(401);
    expect((await session(req('session', '', 'x'.repeat(40)))).status).toBe(
      401
    );
    expect((await events(req('events', '{}', 'nope'))).status).toBe(401);
    expect((await backfill(req('backfill', '{}', null))).status).toBe(401);
    vi.stubEnv('PBX_GATEWAY_SECRET', '');
    expect((await session(req('session', ''))).status).toBe(503);
    expect(fake.log).toHaveLength(0);
  });
});

describe('POST session', () => {
  it('answers the socket URL and topics, and nothing of the credentials', async () => {
    const res = await session(req('session', ''));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ['connectionId', 'refreshAfterMs', 'topics', 'wsUrl'].sort()
    );
    expect(body.connectionId).toBe('c1');
    expect(body.wsUrl).toBe(
      'wss://pbx.example.com/openapi/v1.0/subscribe?access_token=TOKEN-abc'
    );
    expect(body.topics).toContain(30012);
    expect(JSON.stringify(body)).not.toMatch(/ENC-SECRET|client_secret/i);
  });

  it('refuses to guess between several connections', async () => {
    fake.tables.pbx_connections.push({ id: 'c2', created_at: '2' });
    expect((await session(req('session', ''))).status).toBe(409);
    vi.stubEnv('PBX_CONNECTION_ID', 'c2');
    expect(
      (await (await session(req('session', ''))).json()).connectionId
    ).toBe('c2');
  });
});

describe('POST events', () => {
  it('stores the raw frame once', async () => {
    const frame = JSON.stringify({
      type: 30009,
      msg: { extension: '1001', status: 'away' },
    });
    const first = await (await events(req('events', frame))).json();
    const again = await (await events(req('events', frame))).json();
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(fake.tables.pbx_events_raw).toHaveLength(1);
    expect(fake.tables.pbx_events_raw[0].connection_id).toBe('c1');
  });

  it('503 when the frame could not be stored, so the gateway retries', async () => {
    fake.fail('pbx_events_raw', 'upsert', { message: 'down' });
    expect((await events(req('events', '{"type":30009}'))).status).toBe(503);
  });
});

describe('POST backfill', () => {
  it('pages through the window, dedupes by uid and ingests raw 30012 frames', async () => {
    const rows = CDR_SEARCH_OK.data as Record<string, unknown>[];
    h.searchCdr
      .mockResolvedValueOnce({ total: 4, records: [...rows] })
      .mockResolvedValueOnce({ total: 4, records: [rows[0]] });
    const to = new Date();
    const from = new Date(to.getTime() - 48 * 3600_000);
    const res = await backfill(
      req(
        'backfill',
        JSON.stringify({ from: from.toISOString(), to: to.toISOString() })
      )
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.records).toBe(rows.length);
    // The window is cut to its last 24 hours.
    const asked = h.searchCdr.mock.calls[0][0];
    expect(asked.endTime.getTime() - asked.startTime.getTime()).toBe(
      24 * 3600_000
    );
    const stored = fake.tables.pbx_events_raw.map(
      (r) => r.payload as { type: number }
    );
    expect(stored).toHaveLength(rows.length);
    expect(stored.every((p) => p.type === 30012)).toBe(true);
  });

  it('reads a CDR row as the same Call End event the socket would carry', () => {
    for (const row of CDR_SEARCH_OK.data as Record<string, unknown>[]) {
      const live = parseYeastarEvent(cdrRecordToEventFrame(row));
      const direct = cdrRecordToCallEnd(row);
      expect(live.ok && direct.ok).toBe(true);
      if (live.ok && direct.ok) {
        const strip = (e: object) => {
          const c = { ...e } as Record<string, unknown>;
          delete c.raw;
          return c;
        };
        expect(strip(live.event)).toEqual(strip(direct.event));
      }
    }
  });

  it('400 on a missing or reversed window', async () => {
    expect((await backfill(req('backfill', '{"from":"x"}'))).status).toBe(400);
    expect(
      (
        await backfill(
          req(
            'backfill',
            '{"from":"2026-10-12T10:00:00Z","to":"2026-10-12T09:00:00Z"}'
          )
        )
      ).status
    ).toBe(400);
  });
});
