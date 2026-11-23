import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeDb, type Row } from '@/lib/whatsapp/broadcast.fake';

const h = vi.hoisted(() => ({
  db: null as unknown,
  afterCallbacks: [] as (() => Promise<void>)[],
  send: vi.fn(),
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
  createBroadcast: async () => ({
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
  }),
}));

import { POST } from './route';
import { claimBroadcastDelivery } from '@/lib/whatsapp/broadcast-resume';

let broadcast: Row;
let recipient: Row;

beforeEach(() => {
  h.afterCallbacks.length = 0;
  h.send.mockReset().mockResolvedValue({ messageId: 'wamid.1' });
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

const post = () =>
  POST(
    new Request('http://x/api/v1/broadcasts', {
      method: 'POST',
      body: JSON.stringify({
        template_name: 'promo',
        recipients: [{ to: '+971501000000' }],
      }),
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
});
