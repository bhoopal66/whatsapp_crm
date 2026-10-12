import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getChannelInfo: vi.fn(),
  getChannelSettings: vi.fn(),
  registerWebhook: vi.fn(),
  /** The Whapi row findWhapiRow returns. */
  row: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({}),
  toErrorResponse: () => new Response(null, { status: 403 }),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));

// Real isOurWebhook / describeChannelStatus / WhapiError; the gateway
// calls are stubbed.
vi.mock('@/lib/whatsapp/whapi-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChannelInfo: h.getChannelInfo,
  getChannelSettings: h.getChannelSettings,
  registerWebhook: h.registerWebhook,
}));

/** A chainable, awaitable Supabase fake; `maybeSingle` answers by table. */
function fakeDb() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
    },
    from(table: string) {
      let columns = '';
      const builder: Record<string, unknown> = {};
      for (const m of ['eq', 'neq', 'order', 'limit', 'insert']) {
        builder[m] = () => builder;
      }
      builder.select = (cols: string) => {
        columns = cols;
        return builder;
      };
      builder.update = (payload: Record<string, unknown>) => {
        if (table === 'whatsapp_config') h.updates.push(payload);
        return builder;
      };
      builder.maybeSingle = async () => {
        if (table === 'profiles') {
          return { data: { account_id: 'acct-1' }, error: null };
        }
        // findWhapiRow reads the row; the duplicate/claim checks find none.
        if (table === 'whatsapp_config' && columns.startsWith('id, ')) {
          const isDuplicateCheck = columns === 'id, label, waba_id';
          return { data: isDuplicateCheck ? null : h.row, error: null };
        }
        return { data: null, error: null };
      };
      builder.then = (resolve: (r: unknown) => unknown) =>
        resolve({
          data: table === 'profiles' ? [{ account_id: 'acct-1' }] : [],
          error: null,
        });
      return builder;
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => fakeDb(),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => fakeDb(),
}));

import { GET, POST } from './route';

function channelInfo(status: string, phone: string | null) {
  return {
    status,
    statusCode: 1,
    authorized: status === 'AUTH',
    phone,
    displayName: null,
    version: null,
    uptime: null,
  };
}

function post(body: Record<string, unknown>) {
  return new Request('https://crm.test/api/whatsapp/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = 'https://crm.test';
  h.updates = [];
  h.row = {
    id: 'cfg-1',
    verify_token: 'enc:secret',
    waba_id: '971581842504',
    phone_number_id: 'NIGHTW-JJC9J',
    access_token: 'enc:tok',
    status: 'connected',
    registered_at: '2026-08-27T11:53:00Z',
  };
  h.getChannelInfo.mockReset();
  h.getChannelSettings.mockReset();
  h.registerWebhook.mockReset().mockResolvedValue({ success: true });
});

describe('POST /api/whatsapp/config — re-saving a number', () => {
  it('keeps the known number when a logged-out channel reports none', async () => {
    // During a QR logout /health carries no `user`, so channel.phone is
    // null. Writing that over waba_id erased the number's identity.
    h.getChannelInfo.mockResolvedValue(channelInfo('QR', null));
    const res = await POST(
      post({ token: 'tok', channel_id: 'NIGHTW-JJC9J', config_id: 'cfg-1' })
    );
    expect(res.status).toBe(200);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({
      waba_id: '971581842504',
      status: 'disconnected',
    });
  });

  it('takes the number Whapi reports when there is one', async () => {
    h.getChannelInfo.mockResolvedValue(channelInfo('AUTH', '971500000001'));
    await POST(
      post({ token: 'tok', channel_id: 'NIGHTW-JJC9J', config_id: 'cfg-1' })
    );
    expect(h.updates[0]).toMatchObject({
      waba_id: '971500000001',
      status: 'connected',
    });
  });

  it('keeps the current status while the channel is starting (LAUNCH/INIT)', async () => {
    // Writing 'disconnected' here refused Compass sends until the next
    // sweep, which then sent a "connected again" alert for nothing.
    for (const prev of ['connected', 'disconnected']) {
      for (const word of ['LAUNCH', 'INIT']) {
        h.updates = [];
        h.row = { ...h.row, status: prev };
        h.getChannelInfo.mockResolvedValue(channelInfo(word, '971581842504'));
        await POST(
          post({ token: 'tok', channel_id: 'NIGHTW-JJC9J', config_id: 'cfg-1' })
        );
        expect(h.updates).toHaveLength(1);
        expect(h.updates[0].status).toBe(prev);
        expect(h.updates[0]).not.toHaveProperty('connected_at');
      }
    }
  });

  it('stamps connected_at only when the number actually comes up', async () => {
    h.getChannelInfo.mockResolvedValue(channelInfo('AUTH', '971581842504'));

    h.row = { ...h.row, status: 'connected' };
    await POST(
      post({ token: 'tok', channel_id: 'NIGHTW-JJC9J', config_id: 'cfg-1' })
    );
    expect(h.updates[0].status).toBe('connected');
    expect(h.updates[0]).not.toHaveProperty('connected_at');

    h.updates = [];
    h.row = { ...h.row, status: 'disconnected' };
    await POST(
      post({ token: 'tok', channel_id: 'NIGHTW-JJC9J', config_id: 'cfg-1' })
    );
    expect(h.updates[0].status).toBe('connected');
    expect(typeof h.updates[0].connected_at).toBe('string');
  });

  it('marks a connected number down on ERROR, as the monitor does', async () => {
    h.getChannelInfo.mockResolvedValue(channelInfo('ERROR', '971581842504'));
    await POST(
      post({ token: 'tok', channel_id: 'NIGHTW-JJC9J', config_id: 'cfg-1' })
    );
    expect(h.updates[0].status).toBe('disconnected');
    // The last time it was up stays on record.
    expect(h.updates[0]).not.toHaveProperty('connected_at');
  });
});

describe('GET /api/whatsapp/config — registered webhooks', () => {
  it('marks which webhooks are this CRM’s and keeps the secret redacted', async () => {
    h.getChannelInfo.mockResolvedValue(channelInfo('AUTH', '971581842504'));
    h.getChannelSettings.mockResolvedValue({
      webhooks: [
        { url: 'https://crm.test/api/whatsapp/webhook?secret=abcdef123456' },
        // A tunnel hostname we used before: still ours, by path.
        { url: 'https://old-tunnel.trycloudflare.com/api/whatsapp/webhook' },
        { url: 'https://requestbin.whapi.cloud/1a7yq7j1' },
      ],
    });

    const res = await GET(
      new Request('https://crm.test/api/whatsapp/config?config_id=cfg-1')
    );
    const body = await res.json();

    expect(body.webhook.hooks).toEqual([
      {
        url: 'https://crm.test/api/whatsapp/webhook?secret=abcd****',
        ours: true,
      },
      {
        url: 'https://old-tunnel.trycloudflare.com/api/whatsapp/webhook',
        ours: true,
      },
      { url: 'https://requestbin.whapi.cloud/1a7yq7j1', ours: false },
    ]);
    // The shape the Settings screen reads today is unchanged.
    expect(body.webhook.urls).toEqual(
      body.webhook.hooks.map((hook: { url: string }) => hook.url)
    );
    expect(JSON.stringify(body)).not.toContain('abcdef123456');
  });
});
