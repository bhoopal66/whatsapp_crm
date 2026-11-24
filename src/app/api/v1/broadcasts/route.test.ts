import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeDb, type Row } from '@/lib/whatsapp/broadcast.fake';

const h = vi.hoisted(() => ({
  db: null as unknown,
  afterCallbacks: [] as (() => Promise<void>)[],
  send: vi.fn(),
  create: vi.fn(),
}));

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (cb: () => Promise<void>) => h.afterCallbacks.push(cb),
}));
vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async () => ({
    accountId: 'acct-1',
    keyId: 'key-1',
    supabase: h.db,
  }),
}));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v }));
vi.mock('@/lib/api/v1/contacts', async (orig) => ({
  ...(await orig<typeof import('@/lib/api/v1/contacts')>()),
  resolveAuditUserId: async () => 'owner-1',
}));
vi.mock('@/lib/whatsapp/provider', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/provider')>()),
  sendTemplate: h.send,
}));
vi.mock('@/lib/whatsapp/broadcast-core', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/broadcast-core')>()),
  createBroadcast: h.create,
}));

const PLAN = {
  broadcastId: 'bc-1',
  templateName: 'promo',
  templateLanguage: 'en_US',
  channelId: 'pn-1',
  channel: { id: 'cfg-1', accountId: 'acct-1', provider: 'meta' },
  templateRow: { name: 'promo' },
  planned: [
    {
      recipientRowId: 'r0',
      contactId: null,
      phone: '971501000000',
      params: [],
    },
  ],
  rejected: 0,
  skippedOptedOut: 0,
};

import { BroadcastError } from '@/lib/whatsapp/broadcast-core';
import { POST } from './route';
import { claimBroadcastDelivery } from '@/lib/whatsapp/broadcast-resume';

let broadcast: Row;
let recipient: Row;
let keys: Row[];
let noKeys: boolean;

beforeEach(() => {
  h.afterCallbacks.length = 0;
  keys = [];
  noKeys = false;
  h.send.mockReset().mockResolvedValue({ messageId: 'wamid.1' });
  h.create.mockReset().mockResolvedValue(PLAN);
  broadcast = {
    id: 'bc-1',
    account_id: 'acct-1',
    status: 'sending',
    delivery_locked_at: null,
  };
  recipient = {
    id: 'r0',
    broadcast_id: 'bc-1',
    status: 'pending',
    error_message: null,
  };
  h.db = Object.assign(
    fakeDb(
      {
        broadcasts: [broadcast],
        broadcast_recipients: [recipient],
        v1_message_keys: keys,
      },
      {
        // The table's defaults and its unique key.
        refuseInsert: (table, [row]) => {
          if (table !== 'v1_message_keys') return null;
          if (noKeys) return { code: 'PGRST205', message: 'no table' };
          if (keys.some((k) => k.key === row.key)) {
            return { code: '23505', message: 'duplicate' };
          }
          Object.assign(row, { id: `k${keys.length}`, state: 'claimed' });
          return null;
        },
      }
    ),
    { rpc: async () => ({ data: 0, error: null }) }
  );
});
afterEach(() => vi.restoreAllMocks());

const BODY = {
  template_name: 'promo',
  recipients: [{ to: '+971501000000' }] as unknown[],
};
const post = (body: unknown = BODY, headers: Record<string, string> = {}) =>
  POST(
    new Request('http://x/api/v1/broadcasts', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  );

const ACCEPTED = {
  broadcast_id: 'bc-1',
  status: 'sending',
  total_recipients: 1,
  accepted: 1,
  rejected: 0,
};

describe('POST /api/v1/broadcasts', () => {
  it('delivers under the delivery lock, which keeps a Resume out', async () => {
    const res = await post();
    expect(res.status).toBe(202);
    expect((await res.json()).data).toEqual(ACCEPTED);

    let resumed: boolean | undefined;
    h.send.mockImplementationOnce(async () => {
      resumed = await claimBroadcastDelivery(h.db as never, 'acct-1', 'bc-1');
      return { messageId: 'wamid.1' };
    });
    for (const cb of h.afterCallbacks) await cb();

    expect(resumed).toBe(false);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(recipient.status).toBe('sent');
    expect(broadcast).toMatchObject({
      status: 'sent',
      delivery_locked_at: null,
    });
  });

  it('answers 202 and sends nothing when a Resume has the lock', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const theirs = new Date().toISOString();
    broadcast.delivery_locked_at = theirs;

    const res = await post();
    expect(res.status).toBe(202);
    expect((await res.json()).data).toEqual(ACCEPTED);
    expect(h.afterCallbacks).toHaveLength(0);
    expect(logged.mock.calls.join()).toContain('bc-1');
    expect(broadcast.delivery_locked_at).toBe(theirs);
    expect(recipient.status).toBe('pending');
  });

  it('sends a number as text, in its own place', async () => {
    const to = '+971501000000';
    const res = await post({
      ...BODY,
      recipients: [{ to, params: ['Jane', 50000, '5.9'] }, { to }],
    });
    expect(res.status).toBe(202);
    expect(h.create.mock.calls[0][3].recipients).toEqual([
      { to, params: ['Jane', '50000', '5.9'] },
      { to, params: undefined },
    ]);
  });

  it.each([[['Jane', null]], [['Jane', true]], ['Jane']])(
    'refuses the params %j before anything is created',
    async (params) => {
      const to = '+971501000000';
      const res = await post({ ...BODY, recipients: [{ to }, { to, params }] });
      expect(res.status).toBe(400);
      const { error } = await res.json();
      expect(error.code).toBe('bad_request');
      expect(error.message).toContain('recipients[1].params');
      expect(h.create).not.toHaveBeenCalled();
    }
  );
});

describe('POST /api/v1/broadcasts with an Idempotency-Key', () => {
  const keyed = async (body: unknown = BODY, key = 'k-1') => {
    const res = await post(body, { 'Idempotency-Key': key });
    const json = await res.json();
    return { status: res.status, data: json.data, code: json.error?.code };
  };
  type Params = { beforeCreate?: () => Promise<void> };
  /** The core: past `beforeCreate` the campaign may exist. */
  const insert = vi.fn();
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    insert.mockReset().mockResolvedValue(PLAN);
    h.create.mockImplementation(async (_db, _acct, _user, p: Params) => {
      await p.beforeCreate?.();
      return insert();
    });
  });

  it('answers a repeat with the first campaign and delivers once', async () => {
    expect(await keyed()).toEqual({ status: 202, data: ACCEPTED });
    expect(await keyed()).toEqual({
      status: 200,
      data: { ...ACCEPTED, replayed: true },
    });
    const asField = await post({ ...BODY, idempotency_key: 'k-1' });
    expect(asField.status).toBe(200);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(h.afterCallbacks).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      state: 'sent',
      contact_id: null,
      message_id: null,
    });
  });

  it('keeps its keys apart from those of messages, at any length', async () => {
    await keyed(BODY, 'k'.repeat(200));
    expect(keys[0].key).toMatch(/^broadcast§[0-9a-f]{64}$/);
  });

  it('refuses the key for another broadcast', async () => {
    await keyed();
    expect(await keyed({ ...BODY, name: 'July' })).toMatchObject({
      status: 409,
      code: 'idempotency_key_reused',
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('holds a repeat off while the first still resolves its recipients', async () => {
    let resolved = () => {};
    h.create.mockImplementationOnce(async (_db, _acct, _user, p: Params) => {
      await new Promise<void>((r) => (resolved = r));
      await p.beforeCreate?.();
      return insert();
    });
    const first = keyed();
    await vi.waitFor(() => expect(keys).toHaveLength(1));
    // Well past a message's two minutes.
    keys[0].claimed_at = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(await keyed()).toMatchObject({ status: 409, code: 'in_progress' });
    resolved();
    expect(await first).toMatchObject({ status: 202 });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('creates nothing once its claim was called unconfirmed', async () => {
    h.create.mockImplementationOnce(async (_db, _acct, _user, p: Params) => {
      keys[0].claimed_at = new Date(Date.now() - 16 * 60_000).toISOString();
      expect(await keyed()).toMatchObject({ code: 'delivery_unconfirmed' });
      await p.beforeCreate?.();
      return insert();
    });
    expect(await keyed()).toMatchObject({ code: 'delivery_unconfirmed' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('lets a refused request try again with its key', async () => {
    h.create.mockRejectedValueOnce(
      new BroadcastError('template_not_found', 'No template', 404)
    );
    expect(await keyed()).toMatchObject({
      status: 404,
      code: 'template_not_found',
    });
    expect(await keyed()).toMatchObject({ status: 202 });
  });

  it('never creates again when the insert got no answer', async () => {
    insert.mockRejectedValueOnce(
      new BroadcastError('internal', 'Failed to create broadcast', 500)
    );
    const unknown = { status: 409, code: 'delivery_unconfirmed' };
    expect(await keyed()).toMatchObject(unknown);
    expect(await keyed()).toMatchObject(unknown);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('creates nothing when the key cannot be recorded', async () => {
    noKeys = true;
    expect(await keyed()).toMatchObject({ status: 503, code: 'unavailable' });
    expect(h.create).not.toHaveBeenCalled();
  });

  it('refuses an unusable key', async () => {
    expect(await keyed(BODY, 'k'.repeat(201))).toMatchObject({ status: 400 });
    expect(h.create).not.toHaveBeenCalled();
  });
});
