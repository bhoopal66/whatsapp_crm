import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getChannelInfo: vi.fn(),
  getChannelSettings: vi.fn(),
  registerWebhook: vi.fn(),
  /** The Whapi row findWhapiRow returns. */
  row: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  eqs: [] as unknown[][],
  /** Read/write errors to inject, by select columns or 'update'/'insert'. */
  fail: {} as Record<string, { message: string; code?: string }>,
  inserts: [] as Record<string, unknown>[],
  /** Rows the sibling count sees. */
  siblings: 0,
  /** Customer messages still waiting for the number. */
  waiting: 0,
  /** Delete calls on whatsapp_config. */
  deletes: 0,
}));

vi.mock('@/lib/whatsapp/waiting-messages', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  waitingMessages: async () => h.waiting,
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
      let head = false;
      let updating = false;
      const builder: Record<string, unknown> = {};
      for (const m of ['neq', 'order', 'limit']) {
        builder[m] = () => builder;
      }
      builder.delete = () => {
        if (table === 'whatsapp_config') h.deletes++;
        return builder;
      };
      builder.eq = (col: string, val: unknown) => {
        h.eqs.push([table, col, val]);
        return builder;
      };
      builder.select = (cols: string, opts?: { head?: boolean }) => {
        columns = cols;
        head = Boolean(opts?.head);
        return builder;
      };
      builder.insert = (payload: Record<string, unknown>) => {
        h.inserts.push(payload);
        return builder;
      };
      builder.single = async () => ({
        data: h.fail.insert ? null : { id: 'new-1' },
        error: h.fail.insert ?? null,
      });
      builder.update = (payload: Record<string, unknown>) => {
        if (table === 'whatsapp_config') h.updates.push(payload);
        updating = true;
        return builder;
      };
      builder.maybeSingle = async () => {
        if (table === 'profiles') {
          return { data: { account_id: 'acct-1' }, error: null };
        }
        if (h.fail[columns]) return { data: null, error: h.fail[columns] };
        // findWhapiRow reads the row; the duplicate/claim checks find none.
        if (
          table === 'whatsapp_config' &&
          (columns.startsWith('id, ') || columns === 'id')
        ) {
          const isDuplicateCheck = columns === 'id, label, waba_id';
          return { data: isDuplicateCheck ? null : h.row, error: null };
        }
        return { data: null, error: null };
      };
      builder.then = (resolve: (r: unknown) => unknown) => {
        if (head) {
          return resolve({
            count: h.siblings,
            error: h.fail.count ?? null,
          });
        }
        if (h.fail[columns])
          return resolve({ data: null, error: h.fail[columns] });
        return resolve({
          data: table === 'profiles' ? [{ account_id: 'acct-1' }] : [],
          error: updating ? (h.fail.update ?? null) : null,
        });
      };
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

import { DELETE, GET, POST } from './route';

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
  h.eqs = [];
  h.fail = {};
  h.inserts = [];
  h.siblings = 0;
  h.deletes = 0;
  h.row = {
    id: 'cfg-1',
    verify_token: 'enc:secret',
    waba_id: '971500001234',
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
      waba_id: '971500001234',
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
        h.getChannelInfo.mockResolvedValue(channelInfo(word, '971500001234'));
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
    h.getChannelInfo.mockResolvedValue(channelInfo('AUTH', '971500001234'));

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
    h.getChannelInfo.mockResolvedValue(channelInfo('ERROR', '971500001234'));
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
    h.getChannelInfo.mockResolvedValue(channelInfo('AUTH', '971500001234'));
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

describe('DELETE /api/whatsapp/config — default hand-over', () => {
  it('only ever promotes a shared number (is_personal = false)', async () => {
    const res = await DELETE(
      new Request('https://crm.test/api/whatsapp/config?config_id=cfg-1', {
        method: 'DELETE',
      })
    );
    expect(res.status).toBe(200);
    expect(h.eqs).toContainEqual(['whatsapp_config', 'is_personal', false]);
  });
});

describe('DELETE /api/whatsapp/config — waiting customer messages', () => {
  const del = (q = '') =>
    DELETE(
      new Request(`https://crm.test/api/whatsapp/config?config_id=cfg-1${q}`, {
        method: 'DELETE',
      })
    );

  it('answers 409 messages_waiting and deletes nothing', async () => {
    h.waiting = 3;
    const res = await del();
    h.waiting = 0;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'messages_waiting',
      count: 3,
    });
    expect(h.deletes).toBe(0);
  });

  it('removes the number when the request says force', async () => {
    h.waiting = 3;
    const res = await del('&force=1');
    h.waiting = 0;
    expect(res.status).toBe(200);
    expect(h.deletes).toBe(1);
  });
});

describe('DELETE /api/whatsapp/config — a failed read', () => {
  it('answers 500 and removes nothing, not success', async () => {
    h.fail['id'] = { message: 'connection reset' };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await DELETE(
      new Request('https://crm.test/api/whatsapp/config?config_id=cfg-1', {
        method: 'DELETE',
      })
    );
    error.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.json()).toHaveProperty('error');
  });
});

describe('POST /api/whatsapp/config — failed reads and a failed save', () => {
  const save = (extra: Record<string, unknown> = {}) =>
    POST(
      post({
        token: 'tok',
        channel_id: 'NIGHTW-JJC9J',
        config_id: 'cfg-1',
        ...extra,
      })
    );

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.getChannelInfo.mockResolvedValue(channelInfo('AUTH', '971500001234'));
  });

  it.each([
    ['the duplicate-channel read', 'id, label, waba_id'],
    ['the same-phone read', 'id, account_id, label'],
    ['the row read', 'id, waba_id, status'],
  ])('answers 500 and writes nothing when %s fails', async (_n, columns) => {
    h.fail[columns] = { message: 'connection reset' };
    const res = await save();
    expect(res.status).toBe(500);
    expect(h.updates).toHaveLength(0);
    expect(h.registerWebhook).not.toHaveBeenCalled();
  });

  it('points the channel back at the old secret when the row write fails', async () => {
    h.fail.update = { message: 'write failed' };
    const res = await save({ rotate_secret: true });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'Failed to update configuration',
    });
    expect(h.registerWebhook).toHaveBeenCalledTimes(2);
    const first = h.registerWebhook.mock.calls[0][0].webhookUrl as string;
    const second = h.registerWebhook.mock.calls[1][0].webhookUrl as string;
    expect(first).not.toContain('secret=secret');
    expect(second).toContain('secret=secret');
  });

  it('the webhook looks a saved secret up afresh, and not after a failed save', async () => {
    const lookup = await import('@/lib/whatsapp/webhook-secret-lookup');
    const changed = vi.spyOn(lookup, 'webhookSecretsChanged');
    h.fail.update = { message: 'write failed' };
    await save({ rotate_secret: true });
    expect(changed).not.toHaveBeenCalled();
    h.fail.update = null;
    await save({ rotate_secret: true });
    expect(changed).toHaveBeenCalledWith('whapi');
  });

  it('does not restore when the secret was kept', async () => {
    h.fail.update = { message: 'write failed' };
    await save();
    expect(h.registerWebhook).toHaveBeenCalledTimes(1);
  });

  it('does not restore onto a channel of another phone', async () => {
    h.fail.update = { message: 'write failed' };
    h.getChannelInfo.mockResolvedValue(channelInfo('AUTH', '971599999999'));
    await save({ rotate_secret: true });
    expect(h.registerWebhook).toHaveBeenCalledTimes(1);
  });

  it('keeps the row-write error when the restore fails too', async () => {
    h.fail.update = { message: 'write failed' };
    h.registerWebhook
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('gateway down'));
    const res = await save({ rotate_secret: true });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'Failed to update configuration',
    });
  });

  it('refuses a rotation whose registration fails, keeping the stored secret', async () => {
    // The gateway times out after applying the new address, then answers.
    h.registerWebhook
      .mockRejectedValueOnce(new Error('gateway timeout'))
      .mockResolvedValueOnce({ success: true });
    const res = await save({ rotate_secret: true });
    expect(res.status).toBe(502);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('secret was not changed');
    expect(error).toContain('keeps receiving');
    expect(h.updates).toHaveLength(0);
    expect(h.registerWebhook).toHaveBeenCalledTimes(2);
    expect(h.registerWebhook.mock.calls[1][0].webhookUrl).toContain(
      'secret=secret'
    );
  });

  it('refuses the rotation when the callback cannot be put back either', async () => {
    h.registerWebhook
      .mockRejectedValueOnce(new Error('gateway down'))
      .mockRejectedValueOnce(new Error('gateway down'));
    const res = await save({ rotate_secret: true });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain(
      'if messages stop arriving'
    );
    expect(h.updates).toHaveLength(0);
  });

  it('does not put the old callback on a channel of another phone', async () => {
    h.registerWebhook.mockRejectedValueOnce(new Error('gateway down'));
    h.getChannelInfo.mockResolvedValue(channelInfo('AUTH', '971599999999'));
    const res = await save({ rotate_secret: true });
    expect(res.status).toBe(502);
    expect(h.updates).toHaveLength(0);
    expect(h.registerWebhook).toHaveBeenCalledTimes(1);
  });

  it('still saves a re-save and a first connection whose registration fails', async () => {
    h.registerWebhook.mockRejectedValueOnce(new Error('gateway down'));
    const again = await save();
    expect(again.status).toBe(200);
    expect(h.updates[0].verify_token).toBe('enc:secret');

    h.registerWebhook.mockRejectedValueOnce(new Error('gateway down'));
    const first = await POST(
      post({
        token: 'tok',
        channel_id: 'NEW-CHANNEL',
        create: true,
        rotate_secret: true,
      })
    );
    expect(first.status).toBe(200);
    expect(h.inserts).toHaveLength(1);
  });

  it('has nothing to restore when a new number fails to insert', async () => {
    h.fail.insert = { message: 'insert failed' };
    const res = await POST(
      post({ token: 'tok', channel_id: 'NEW-CHANNEL', create: true })
    );
    expect(res.status).toBe(500);
    expect(h.registerWebhook).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/whatsapp/config — the first shared number is the default', () => {
  const connect = () =>
    POST(post({ token: 'tok', channel_id: 'NEW-CHANNEL', create: true }));

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.getChannelInfo.mockResolvedValue(channelInfo('AUTH', '971500001234'));
  });

  it('counts only shared rows, so a personal number does not take the default', async () => {
    h.siblings = 0;
    const res = await connect();
    expect(res.status).toBe(200);
    expect(h.eqs).toContainEqual(['whatsapp_config', 'is_personal', false]);
    expect(h.inserts[0]).toMatchObject({ is_primary: true });
  });

  it('is not the default when a shared number already exists', async () => {
    h.siblings = 1;
    await connect();
    expect(h.inserts[0]).toMatchObject({ is_primary: false });
  });

  it('answers 500 when the sibling count fails, and inserts nothing', async () => {
    h.fail.count = { message: 'connection reset' };
    const res = await connect();
    expect(res.status).toBe(500);
    expect(h.inserts).toHaveLength(0);
  });
});
