import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// POST /api/whatsapp/config/meta — connecting the Meta number. Graph is
// stubbed at `fetch`, so the real meta-api helpers (including the WABA
// phone-number listing and its pagination) run; the database is a fake
// that records writes.
// ---------------------------------------------------------------------------

const PHONE = '713442518525749';
const WABA = '491532200719769';

interface Query {
  table: string;
  op: 'select' | 'update' | 'insert';
  payload?: unknown;
  filters: [string, string, unknown][];
  count?: boolean;
}

const db = {
  existing: null as Record<string, unknown> | null,
  claimed: null as Record<string, unknown> | null,
  writes: [] as Query[],
};

function makeSupabase() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from(table: string) {
      const q: Query = { table, op: 'select', filters: [] };
      const b: Record<string, unknown> = {};
      b.select = (_cols: string, opts?: { count?: string }) => {
        if (opts?.count) q.count = true;
        return b;
      };
      for (const f of ['eq', 'neq']) {
        b[f] = (col: string, val: unknown) => {
          q.filters.push([f, col, val]);
          return b;
        };
      }
      b.order = () => b;
      b.update = (payload: unknown) => {
        q.op = 'update';
        q.payload = payload;
        return b;
      };
      b.insert = async (payload: unknown) => {
        db.writes.push({ ...q, op: 'insert', payload });
        return { error: null };
      };
      b.maybeSingle = async () => {
        if (table === 'profiles') {
          return { data: { account_id: 'acc-1' }, error: null };
        }
        const isClaimCheck = q.filters.some(([f]) => f === 'neq');
        return { data: isClaimCheck ? db.claimed : db.existing, error: null };
      };
      b.then = (resolve: (v: unknown) => unknown) => {
        if (q.op === 'update') {
          db.writes.push(q);
          return resolve({ error: null });
        }
        return resolve({ count: 0, data: [], error: null });
      };
      return b;
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeSupabase(),
}));

const requireRole = vi.fn();
vi.mock('@/lib/auth/account', () => ({
  requireRole: (...a: unknown[]) => requireRole(...a),
  toErrorResponse: (err: unknown) =>
    new Response(JSON.stringify({ error: String(err) }), { status: 500 }),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  // Identity, so fixtures can carry plaintext credentials.
  encrypt: (v: string) => v,
  decrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));

/** What the fake Graph answers. */
const graph = {
  /** Pages of `GET /{waba}/phone_numbers`; each page links to the next. */
  wabaPages: [[{ id: PHONE }]] as { id: string }[][],
  wabaListStatus: 200,
};

const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  if (url.pathname.endsWith('/phone_numbers')) {
    if (graph.wabaListStatus !== 200) {
      return json(
        {
          error: {
            message: '(#200) Requires whatsapp_business_management permission',
            code: 10,
          },
        },
        graph.wabaListStatus
      );
    }
    const page = Number(url.searchParams.get('page') ?? '0');
    const next =
      page + 1 < graph.wabaPages.length
        ? `${url.origin}${url.pathname}?page=${page + 1}`
        : undefined;
    return json({
      data: graph.wabaPages[page] ?? [],
      ...(next ? { paging: { next } } : {}),
    });
  }
  if (url.pathname.endsWith('/subscribed_apps') && method === 'POST') {
    return json({ success: true });
  }
  // GET /{phone_number_id} — verifyPhoneNumber.
  const id = url.pathname.split('/').pop();
  return json({
    id,
    display_phone_number: '+971 50 000 0000',
    verified_name: 'Taamul',
    quality_rating: 'GREEN',
  });
});

import { POST } from './route';

function save(body: Record<string, unknown>) {
  return POST(
    new Request('http://localhost/api/whatsapp/config/meta', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}

function graphCalls(): { method: string; path: string; auth: string }[] {
  return fetchMock.mock.calls.map(([input, init]) => ({
    method: init?.method ?? 'GET',
    path: new URL(String(input)).pathname,
    auth: String(
      (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
    ),
  }));
}

const subscribeCalls = () =>
  graphCalls().filter(
    (c) => c.method === 'POST' && c.path.endsWith('/subscribed_apps')
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  requireRole.mockResolvedValue({ accountId: 'acc-1', role: 'admin' });
  db.existing = null;
  db.claimed = null;
  db.writes = [];
  graph.wabaPages = [[{ id: PHONE }]];
  graph.wabaListStatus = 200;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('POST /api/whatsapp/config/meta — one Meta number per account', () => {
  const connected = {
    id: 'cfg-meta',
    access_token: 'stored-token',
    phone_number_id: PHONE,
    waba_id: WABA,
  };

  it('refuses a different phone number id with 409, before any Graph call', async () => {
    db.existing = connected;
    const res = await save({
      phone_number_id: '819779421230083',
      waba_id: WABA,
      access_token: 'new-token',
    });

    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error).toContain('already has a Meta number connected');
    expect(error).toContain('…5749');
    expect(error).toContain('disconnect it first');
    // The live row is untouched and Graph was never asked anything.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it('corrects the WABA id of the same number when the new WABA lists it', async () => {
    // A mistyped WABA id can be stored; refusing the fix left only
    // Disconnect, which drops the routes and unlinks the conversations.
    db.existing = { ...connected, waba_id: '999888777' };
    const res = await save({ phone_number_id: PHONE, waba_id: WABA });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ saved: true, subscribed: true });
    const listings = graphCalls().filter((c) =>
      c.path.endsWith('/phone_numbers')
    );
    expect(listings.map((c) => c.path)).toEqual([
      expect.stringMatching(new RegExp(`/${WABA}/phone_numbers$`)),
    ]);
    expect(subscribeCalls()).toEqual([
      expect.objectContaining({
        path: expect.stringMatching(new RegExp(`/${WABA}/subscribed_apps$`)),
      }),
    ]);
    // Updated in place: same row, same number, the corrected WABA.
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]).toMatchObject({
      op: 'update',
      payload: { phone_number_id: PHONE, waba_id: WABA },
      filters: [['eq', 'id', 'cfg-meta']],
    });
  });

  it('refuses a WABA correction Meta cannot confirm with 409', async () => {
    db.existing = connected;
    graph.wabaListStatus = 403;
    const res = await save({ phone_number_id: PHONE, waba_id: '999888777' });

    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error).toContain('Could not confirm');
    expect(error).toContain('WhatsApp Business Account 999888777');
    expect(error).toContain('…9769');
    expect(error).toContain('whatsapp_business_management');
    expect(subscribeCalls()).toHaveLength(0);
    expect(db.writes).toEqual([]);
  });

  it('refuses a WABA correction to a WABA that does not list the number with 400', async () => {
    db.existing = connected;
    graph.wabaPages = [[{ id: '111' }]];
    const res = await save({ phone_number_id: PHONE, waba_id: '999888777' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('is not one of the numbers');
    expect(subscribeCalls()).toHaveLength(0);
    expect(db.writes).toEqual([]);
  });

  it('refuses clearing the WABA id of a connected number', async () => {
    db.existing = connected;
    const res = await save({ phone_number_id: PHONE, waba_id: '' });
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it('still re-saves the same number and WABA, reusing the stored token', async () => {
    db.existing = connected;
    const res = await save({ phone_number_id: PHONE, waba_id: WABA });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ saved: true, subscribed: true });
    expect(graphCalls().every((c) => c.auth === 'Bearer stored-token')).toBe(
      true
    );
    expect(subscribeCalls()).toHaveLength(1);
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]).toMatchObject({
      op: 'update',
      payload: { phone_number_id: PHONE, waba_id: WABA },
      filters: [['eq', 'id', 'cfg-meta']],
    });
  });

  it('lets a row saved without a WABA id have one filled in', async () => {
    db.existing = { ...connected, waba_id: null };
    const res = await save({ phone_number_id: PHONE, waba_id: WABA });
    expect(res.status).toBe(200);
    expect(subscribeCalls()).toHaveLength(1);
    expect(db.writes[0]).toMatchObject({
      op: 'update',
      payload: { waba_id: WABA },
    });
  });
});

describe('POST /api/whatsapp/config/meta — the phone number must be in the WABA', () => {
  it('rejects with 400, and subscribes nothing, when the WABA does not list the number', async () => {
    graph.wabaPages = [[{ id: '111' }, { id: '222' }]];
    const res = await save({
      phone_number_id: PHONE,
      waba_id: WABA,
      access_token: 'tok',
    });

    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain(`Phone number id ${PHONE}`);
    expect(error).toContain(`WhatsApp Business Account ${WABA}`);
    expect(subscribeCalls()).toHaveLength(0);
    expect(db.writes).toEqual([]);
  });

  it('checks the listing with the same token and follows its pagination', async () => {
    graph.wabaPages = [[{ id: '111' }], [{ id: PHONE }]];
    const res = await save({
      phone_number_id: PHONE,
      waba_id: WABA,
      access_token: 'tok',
    });

    expect(res.status).toBe(200);
    const listings = graphCalls().filter((c) =>
      c.path.endsWith(`/${WABA}/phone_numbers`)
    );
    expect(listings).toHaveLength(2);
    expect(listings.every((c) => c.auth === 'Bearer tok')).toBe(true);
    expect(subscribeCalls()).toHaveLength(1);
    expect(db.writes[0]).toMatchObject({
      op: 'insert',
      payload: { provider: 'meta', phone_number_id: PHONE, waba_id: WABA },
    });
  });

  it('saves without subscribing when the listing itself fails', async () => {
    // A token without whatsapp_business_management cannot list — nor
    // subscribe. Same outcome as a failed subscribe used to be.
    graph.wabaListStatus = 403;
    const res = await save({
      phone_number_id: PHONE,
      waba_id: WABA,
      access_token: 'tok',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ saved: true, subscribed: false });
    expect(body.subscribe_error).toContain('whatsapp_business_management');
    expect(subscribeCalls()).toHaveLength(0);
    expect(db.writes[0]).toMatchObject({
      op: 'insert',
      payload: { subscribed_apps_at: null },
    });
  });

  it('skips the check (and the subscription) when no WABA id is given', async () => {
    const res = await save({ phone_number_id: PHONE, access_token: 'tok' });
    expect(res.status).toBe(200);
    expect(graphCalls().some((c) => c.path.endsWith('/phone_numbers'))).toBe(
      false
    );
    expect(subscribeCalls()).toHaveLength(0);
  });

  it('still refuses a phone number id another account owns', async () => {
    db.claimed = { account_id: 'acc-2' };
    const res = await save({
      phone_number_id: PHONE,
      waba_id: WABA,
      access_token: 'tok',
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('another account');
    expect(subscribeCalls()).toHaveLength(0);
  });
});
