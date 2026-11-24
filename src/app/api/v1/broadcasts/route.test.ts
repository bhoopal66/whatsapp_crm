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
  requireApiKey: async () => ({ accountId: 'acct-1', supabase: h.db }),
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

import { POST } from './route';
import { claimBroadcastDelivery } from '@/lib/whatsapp/broadcast-resume';

let broadcast: Row;
let recipient: Row;

beforeEach(() => {
  h.afterCallbacks.length = 0;
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
    fakeDb({ broadcasts: [broadcast], broadcast_recipients: [recipient] }),
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
