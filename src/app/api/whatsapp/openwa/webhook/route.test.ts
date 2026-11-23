import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

/**
 * Scope: what this route OWNS — resolving the number from the payload's
 * session id, signature verification, edge screening keys, and handing
 * the pipeline the right channel inside `after()`. The pipeline itself
 * is shared with the other hubs and tested on its own.
 */

const SECRET = 'openwa_webhook_secret';

const h = vi.hoisted(() => ({
  processMessage: vi.fn(),
  persistOwnSend: vi.fn(),
  handleStatusUpdate: vi.fn(),
  screenWebhook: vi.fn(),
  confirmAccepted: vi.fn(),
  clientIp: vi.fn(),
  persistGroupMessages: vi.fn(),
  applyGroupStatuses: vi.fn(),
  applyGroupEvents: vi.fn(),
  afterCallbacks: [] as (() => Promise<void> | void)[],
  lookups: [] as Record<string, unknown>[],
  state: {
    configs: [] as Record<string, unknown>[],
    failLookup: false,
  },
}));

vi.mock('next/server', async () => {
  const actual =
    await vi.importActual<typeof import('next/server')>('next/server');
  return {
    ...actual,
    after: (cb: () => Promise<void> | void) => {
      h.afterCallbacks.push(cb);
    },
  };
});

vi.mock('@/lib/whatsapp/inbound-pipeline', () => ({
  processMessage: h.processMessage,
  handleStatusUpdate: h.handleStatusUpdate,
}));

vi.mock('@/lib/groups/inbound', () => ({
  persistGroupMessages: h.persistGroupMessages,
  applyGroupStatuses: h.applyGroupStatuses,
  applyGroupEvents: h.applyGroupEvents,
}));

vi.mock('@/lib/whatsapp/own-send', () => ({
  persistOwnSend: h.persistOwnSend,
  resolveOpenWALidPhone: vi.fn(async () => null),
}));

vi.mock('@/lib/edge', () => ({
  clientIp: h.clientIp,
  screenWebhook: h.screenWebhook,
  confirmAccepted: h.confirmAccepted,
  ReplayGuard: class {},
  RateLimiter: class {},
  RpcSeenStore: class {},
  RpcRateStore: class {},
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  // `enc:` marks ciphertext; `bad:` is a value that will not decrypt.
  decrypt: (v: string) => {
    if (v.startsWith('bad:')) throw new Error('decrypt failed');
    return v.replace(/^enc:/, '');
  },
  encrypt: (v: string) => `enc:${v}`,
  isLegacyFormat: () => false,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = { table };
      let rows = [...h.state.configs];
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          rows = rows.filter((r) => r[col] === val);
          return b;
        },
        maybeSingle: async () => {
          h.lookups.push(filters);
          return h.state.failLookup
            ? { data: null, error: { message: 'connection lost' } }
            : { data: rows[0] ?? null, error: null };
        },
      };
      return b;
    },
  }),
}));

vi.mock('@/lib/supabase/urls', () => ({
  serverSupabaseUrl: () => 'https://db.example.supabase.co',
}));

import { POST } from './route';

const CONFIG = {
  id: 'cfg-openwa-1',
  account_id: 'acct-1',
  user_id: 'user-1',
  provider: 'openwa',
  phone_number_id: 'session-1',
  access_token: 'enc:api-key-1',
  verify_token: `enc:${SECRET}`,
  label: 'Sales',
  is_primary: false,
  mirror_inbound_media: false,
  status: 'connected',
};

function sign(body: string, secret = SECRET) {
  return (
    'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  );
}

function messageEvent(id = 'wamid-1', sessionId = 'session-1') {
  return {
    event: 'message.received',
    timestamp: '2026-10-28T08:00:00.000Z',
    sessionId,
    data: {
      id,
      from: '971500000001@c.us',
      chatId: '971500000001@c.us',
      body: 'hello',
      type: 'text',
      kind: 'individual',
      timestamp: 1_761_638_400,
    },
  };
}

function ackEvent() {
  return {
    event: 'message.ack',
    timestamp: '2026-10-28T08:00:00.000Z',
    sessionId: 'session-1',
    data: { messageId: 'out-1', status: 'read', chatId: '971500000001@c.us' },
  };
}

function post(
  payload: unknown,
  opts: { signature?: string | null; raw?: string } = {}
) {
  const body = opts.raw ?? JSON.stringify(payload);
  const signature = opts.signature === undefined ? sign(body) : opts.signature;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (signature !== null) headers['x-openwa-signature'] = signature;
  return POST(
    new Request('https://crm.example.com/api/whatsapp/openwa/webhook', {
      method: 'POST',
      headers,
      body,
    })
  );
}

async function runAfter() {
  for (const cb of h.afterCallbacks.splice(0)) await cb();
}

beforeEach(() => {
  // Reset, not clear: some tests install implementations.
  vi.resetAllMocks();
  h.afterCallbacks.length = 0;
  h.lookups.length = 0;
  h.state.configs = [CONFIG];
  h.state.failLookup = false;
  h.clientIp.mockReturnValue('203.0.113.9');
  h.screenWebhook.mockImplementation(
    async (_ctx: unknown, input: { events: { key: string }[] }) => ({
      status: 200,
      decisions: input.events.map((e) => ({
        key: e.key,
        outcome: 'accept',
        claimToken: `tok:${e.key}`,
      })),
    })
  );
});

describe('OpenWA webhook: request validation', () => {
  it('answers 400 to a body that is not JSON', async () => {
    const res = await post(null, { raw: '{not json' });
    expect(res.status).toBe(400);
    expect(h.lookups).toHaveLength(0);
  });

  it('answers 400 to JSON with no session id', async () => {
    const res = await post({ event: 'message.received', data: {} });
    expect(res.status).toBe(400);
    expect(h.lookups).toHaveLength(0);
  });
});

describe('OpenWA webhook: number lookup', () => {
  it('looks the number up by provider and session id', async () => {
    await post(messageEvent());
    expect(h.lookups).toEqual([
      {
        table: 'whatsapp_config',
        provider: 'openwa',
        phone_number_id: 'session-1',
      },
    ]);
  });

  it('answers 503 when the lookup fails, so OpenWA redelivers', async () => {
    h.state.failLookup = true;
    const res = await post(messageEvent());
    expect(res.status).toBe(503);
    expect(h.afterCallbacks).toHaveLength(0);
  });

  it('answers 200 and processes nothing for an unknown session', async () => {
    const res = await post(messageEvent('wamid-1', 'session-gone'));
    expect(res.status).toBe(200);
    expect(h.screenWebhook).not.toHaveBeenCalled();
    expect(h.afterCallbacks).toHaveLength(0);
  });
});

describe('OpenWA webhook: signature', () => {
  it('accepts a body signed with the number’s secret', async () => {
    const res = await post(messageEvent());
    expect(res.status).toBe(200);
    await runAfter();
    expect(h.processMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects a bad signature with 401 and processes nothing', async () => {
    const res = await post(messageEvent(), {
      signature: sign('something else'),
    });
    expect(res.status).toBe(401);
    expect(h.screenWebhook).not.toHaveBeenCalled();
    expect(h.afterCallbacks).toHaveLength(0);
  });

  it('rejects a body signed with another secret', async () => {
    const body = JSON.stringify(messageEvent());
    const res = await post(null, { raw: body, signature: sign(body, 'x') });
    expect(res.status).toBe(401);
  });

  it('rejects a missing or malformed header with 401', async () => {
    const body = JSON.stringify(messageEvent());
    const hex = sign(body).slice('sha256='.length);
    for (const signature of [null, hex, `sha1=${hex}`]) {
      const res = await post(null, { raw: body, signature });
      expect(res.status).toBe(401);
    }
    expect(h.afterCallbacks).toHaveLength(0);
  });

  it('fails closed when the stored secret will not decrypt', async () => {
    h.state.configs = [{ ...CONFIG, verify_token: `bad:${SECRET}` }];
    const res = await post(messageEvent());
    expect(res.status).toBe(401);
    expect(h.afterCallbacks).toHaveLength(0);
  });

  it('fails closed when the number has no secret, whatever the env holds', async () => {
    process.env.META_APP_SECRET = SECRET;
    h.state.configs = [{ ...CONFIG, verify_token: null }];
    try {
      const res = await post(messageEvent());
      expect(res.status).toBe(401);
    } finally {
      delete process.env.META_APP_SECRET;
    }
  });
});

describe('OpenWA webhook: processing', () => {
  it('screens with keys from the row id, never the payload', async () => {
    await post(messageEvent('wamid-7'));
    await post(ackEvent());
    const keys = h.screenWebhook.mock.calls.map(
      ([, input]) => (input as { events: { key: string }[] }).events
    );
    expect(keys[0]).toEqual([
      expect.objectContaining({
        key: 'openwa:cfg-openwa-1:wamid-7',
        senderKey: '971500000001',
        kind: 'message',
      }),
    ]);
    expect(keys[1]).toEqual([
      { key: 'openwa:status:cfg-openwa-1:out-1:read', kind: 'status' },
    ]);
  });

  it('hands the pipeline an openwa channel built from the row, inside after()', async () => {
    await post(messageEvent());
    // Nothing runs before the after() callback.
    expect(h.processMessage).not.toHaveBeenCalled();
    await runAfter();

    expect(h.processMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wamid-1', from: '971500000001' }),
      'acct-1',
      'user-1',
      expect.objectContaining({
        id: 'cfg-openwa-1',
        accountId: 'acct-1',
        provider: 'openwa',
        phoneNumberId: 'session-1',
        accessToken: 'api-key-1',
      }),
      expect.any(Array),
      undefined
    );
    expect(h.confirmAccepted).toHaveBeenCalledTimes(1);
  });

  it('confirms claims only after the pipeline has finished', async () => {
    let finished = false;
    h.processMessage.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      finished = true;
    });
    h.confirmAccepted.mockImplementation(async () => {
      expect(finished).toBe(true);
    });
    await post(messageEvent());
    await runAfter();
    expect(h.confirmAccepted).toHaveBeenCalledTimes(1);
  });

  it('routes a status to handleStatusUpdate with the authenticated account', async () => {
    await post(ackEvent());
    await runAfter();
    expect(h.handleStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'out-1', status: 'read' }),
      'acct-1'
    );
    expect(h.processMessage).not.toHaveBeenCalled();
  });

  it('keeps a sender over the limit in the inbox without fan-out', async () => {
    h.screenWebhook.mockResolvedValueOnce({
      status: 200,
      decisions: [{ key: 'k', outcome: 'rate_limited', claimToken: 't' }],
    });
    await post(messageEvent());
    await runAfter();
    expect(h.processMessage.mock.calls[0][5]).toEqual({ fanOut: false });
  });

  it('skips a duplicate', async () => {
    h.screenWebhook.mockResolvedValueOnce({
      status: 200,
      decisions: [{ key: 'k', outcome: 'duplicate' }],
    });
    await post(messageEvent());
    await runAfter();
    expect(h.processMessage).not.toHaveBeenCalled();
  });

  it('answers 503, not 429, while another delivery holds a claim', async () => {
    h.screenWebhook.mockResolvedValueOnce({ status: 503, decisions: [] });
    const res = await post(messageEvent());
    expect(res.status).toBe(503);
    expect(h.afterCallbacks).toHaveLength(0);
  });

  it('leaves claims unconfirmed when the pipeline throws', async () => {
    h.processMessage.mockRejectedValueOnce(new Error('db down'));
    await post(messageEvent());
    await runAfter();
    expect(h.confirmAccepted).not.toHaveBeenCalled();
  });

  it('logs dropped unmapped-lid senders as a count only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const payload = messageEvent();
    payload.data.from = '123456789@lid';
    payload.data.chatId = '123456789@lid';
    const res = await post(payload);
    expect(res.status).toBe(200);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('dropped 1 message'))).toBe(true);
    expect(lines.join('\n')).not.toContain('123456789');
    expect(lines.join('\n')).not.toContain('hello');
    warn.mockRestore();
  });
});

describe('OpenWA webhook: own sends (message.sent)', () => {
  function sentEvent() {
    return {
      event: 'message.sent',
      timestamp: '2026-10-28T08:00:00.000Z',
      sessionId: 'session-1',
      data: {
        id: 'own-1',
        from: '971500005678@c.us',
        to: '971500000001@c.us',
        chatId: '971500000001@c.us',
        body: 'typed on the phone',
        type: 'text',
        kind: 'individual',
        fromMe: true,
        timestamp: 1_761_638_400,
      },
    };
  }

  it('ignores an own send on a company number', async () => {
    h.state.configs = [{ ...CONFIG, is_personal: false }];
    const res = await post(sentEvent());
    expect(res.status).toBe(200);
    await runAfter();
    expect(h.persistOwnSend).not.toHaveBeenCalled();
    expect(h.processMessage).not.toHaveBeenCalled();
  });

  it('answers 200 and logs when persisting an own send throws', async () => {
    h.state.configs = [{ ...CONFIG, is_personal: true }];
    h.persistOwnSend.mockRejectedValueOnce(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(sentEvent());
    expect(res.status).toBe(200);
    await runAfter();
    expect(h.persistOwnSend).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('hands an own send on a personal number to persistOwnSend', async () => {
    h.state.configs = [{ ...CONFIG, is_personal: true }];
    const res = await post(sentEvent());
    expect(res.status).toBe(200);
    await runAfter();
    expect(h.processMessage).not.toHaveBeenCalled();
    expect(h.persistOwnSend).toHaveBeenCalledTimes(1);
    const [, channel, send] = h.persistOwnSend.mock.calls[0];
    expect(channel).toMatchObject({
      id: 'cfg-openwa-1',
      isPersonal: true,
      personalUserId: 'user-1',
    });
    expect(send).toEqual({
      id: 'own-1',
      peerPhone: '971500000001',
      text: 'typed on the phone',
      timestamp: '1761638400',
    });
    expect(h.screenWebhook.mock.calls[0][1].events[0].key).toBe(
      'openwa:own:cfg-openwa-1:own-1'
    );
  });
});

describe('OpenWA webhook: groups (migration 114)', () => {
  const groupEvent = () => ({
    event: 'message.received',
    timestamp: '2026-11-17T08:00:00.000Z',
    sessionId: 'session-1',
    data: {
      id: 'grp-1',
      from: '120363000000000001@g.us',
      chatId: '120363000000000001@g.us',
      author: '971500000001@c.us',
      isGroup: true,
      kind: 'group',
      fromMe: false,
      type: 'text',
      body: 'hello group',
      timestamp: 1_763_366_400,
    },
  });

  it('stores a company number’s group message, never through the inbox pipeline', async () => {
    await post(groupEvent());
    await runAfter();
    expect(h.screenWebhook.mock.calls[0][1].events).toEqual([
      { key: 'openwa:group:cfg-openwa-1:grp-1', kind: 'status' },
    ]);
    expect(h.processMessage).not.toHaveBeenCalled();
    expect(h.persistGroupMessages).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'cfg-openwa-1', accountId: 'acct-1', wabaId: null },
      [
        expect.objectContaining({
          id: 'grp-1',
          senderWaId: '971500000001',
          fromMe: false,
        }),
      ]
    );
    expect(h.confirmAccepted).toHaveBeenCalledTimes(1);
  });

  it('drops group traffic on a personal number, as before', async () => {
    h.state.configs = [{ ...CONFIG, is_personal: true }];
    await post(groupEvent());
    await runAfter();
    expect(h.screenWebhook.mock.calls[0][1].events).toEqual([]);
    expect(h.persistGroupMessages).not.toHaveBeenCalled();
    expect(h.applyGroupEvents).not.toHaveBeenCalled();
    expect(h.processMessage).not.toHaveBeenCalled();
  });

  it('applies group.join events on a company number', async () => {
    await post({
      event: 'group.join',
      sessionId: 'session-1',
      data: {
        groupId: '120363000000000001@g.us',
        participantIds: ['971500000002@c.us'],
        timestamp: 1_763_366_400,
      },
    });
    await runAfter();
    expect(h.applyGroupEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'cfg-openwa-1' }),
      [expect.objectContaining({ kind: 'participants', action: 'add' })]
    );
  });

  const joinEvent = {
    event: 'group.join',
    sessionId: 'session-1',
    idempotencyKey: 'idem-77',
    data: {
      groupId: '120363000000000001@g.us',
      participantIds: ['971500000002@c.us'],
      timestamp: 1_763_366_400,
    },
  };

  it('screens a group event under the envelope key', async () => {
    await post(joinEvent);
    await runAfter();
    expect(h.screenWebhook.mock.calls[0][1].events).toEqual([
      { key: 'openwa:gevt:cfg-openwa-1:idem-77:0', kind: 'status' },
    ]);
  });

  it('applies no group event from a redelivery or an IP-limited delivery', async () => {
    for (const outcome of ['duplicate', 'ip_limited']) {
      h.applyGroupEvents.mockClear();
      h.screenWebhook.mockResolvedValueOnce({
        status: 200,
        decisions: [{ key: 'k', outcome }],
      });
      await post(joinEvent);
      await runAfter();
      const applied = h.applyGroupEvents.mock.calls.flatMap((c) => c[2]);
      expect(applied).toEqual([]);
    }
  });

  it('leaves claims unconfirmed when the group write fails, and never throws', async () => {
    h.persistGroupMessages.mockRejectedValue(new Error('db down'));
    const res = await post(groupEvent());
    expect(res.status).toBe(200);
    await runAfter();
    expect(h.confirmAccepted).not.toHaveBeenCalled();
  });
});
