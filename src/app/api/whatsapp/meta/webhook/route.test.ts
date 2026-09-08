import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

/**
 * Scope: what this route OWNS — the subscription handshake, signature
 * verification, and resolving the account from the payload's phone
 * number id.
 *
 * Everything past that point is `lib/whatsapp/inbound-pipeline.ts`,
 * which is shared byte-for-byte with the Whapi route and covered by
 * `app/api/whatsapp/webhook/route.test.ts`. Re-testing the fan-out here
 * would duplicate ~900 lines of assertions for no extra coverage; what
 * IS asserted is that the pipeline gets called with the right channel.
 */

const APP_SECRET = 'test_app_secret';

const h = vi.hoisted(() => ({
  processMessage: vi.fn(),
  handleStatusUpdate: vi.fn(),
  handleTemplateWebhookChange: vi.fn(),
  afterCallbacks: [] as (() => Promise<void> | void)[],
  state: {
    /** Rows `whatsapp_config` returns for provider='meta' lookups. */
    metaConfigs: [] as Record<string, unknown>[],
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

vi.mock('@/lib/whatsapp/template-webhook', () => ({
  handleTemplateWebhookChange: h.handleTemplateWebhookChange,
  isTemplateWebhookField: (f: string) => f.startsWith('message_template_'),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  // Identity, so fixtures can carry plaintext credentials.
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({
          data: h.state.metaConfigs[0] ?? null,
          error: null,
        }),
        // The verify-token / app-secret scans await the builder directly.
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
          resolve({ data: h.state.metaConfigs, error: null }),
      };
      return b;
    },
  }),
}));

vi.mock('@/lib/supabase/urls', () => ({
  serverSupabaseUrl: () => 'https://db.example.supabase.co',
}));

const CONFIG = {
  id: 'cfg-meta',
  account_id: 'acc-1',
  user_id: 'user-1',
  provider: 'meta',
  label: 'Marketing',
  phone_number_id: '109876543210',
  waba_id: '102290129340398',
  access_token: 'meta-token',
  app_secret: APP_SECRET,
  verify_token: 'my-verify-token',
  is_primary: false,
  mirror_inbound_media: true,
  status: 'connected',
};

function sign(body: string, secret = APP_SECRET): string {
  return (
    'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  );
}

function messagePayload(phoneNumberId = '109876543210') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'W1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: phoneNumberId },
              contacts: [{ wa_id: '15551234567', profile: { name: 'Jane' } }],
              messages: [
                {
                  id: 'wamid.ABC',
                  from: '15551234567',
                  timestamp: '1712995245',
                  type: 'text',
                  text: { body: 'hello' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function post(payload: unknown, signature: string | null) {
  const body = JSON.stringify(payload);
  return new Request('https://crm.example.com/api/whatsapp/meta/webhook', {
    method: 'POST',
    headers: signature
      ? { 'content-type': 'application/json', 'x-hub-signature-256': signature }
      : { 'content-type': 'application/json' },
    body,
  });
}

async function runAfterCallbacks() {
  const cbs = [...h.afterCallbacks];
  h.afterCallbacks.length = 0;
  for (const cb of cbs) await cb();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.afterCallbacks.length = 0;
  h.state.metaConfigs = [CONFIG];
  process.env.META_APP_SECRET = APP_SECRET;
  delete process.env.META_VERIFY_TOKEN;
});

describe('GET — Meta subscription handshake', () => {
  it('echoes hub.challenge as bare text/plain when the token matches', async () => {
    const { GET } = await import('./route');
    const res = await GET(
      new Request(
        'https://crm.example.com/api/whatsapp/meta/webhook?hub.mode=subscribe&hub.verify_token=my-verify-token&hub.challenge=1158201444'
      )
    );
    expect(res.status).toBe(200);
    // A JSON wrapper fails verification in the App dashboard with no
    // useful error, so the exact body and content type both matter.
    expect(await res.text()).toBe('1158201444');
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('accepts META_VERIFY_TOKEN for a single-app self-host', async () => {
    h.state.metaConfigs = [];
    process.env.META_VERIFY_TOKEN = 'env-token';
    const { GET } = await import('./route');
    const res = await GET(
      new Request(
        'https://crm.example.com/api/whatsapp/meta/webhook?hub.mode=subscribe&hub.verify_token=env-token&hub.challenge=99'
      )
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('99');
  });

  it('rejects an unrecognised verify token', async () => {
    const { GET } = await import('./route');
    const res = await GET(
      new Request(
        'https://crm.example.com/api/whatsapp/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=99'
      )
    );
    expect(res.status).toBe(403);
  });

  it('answers a plain probe without leaking anything', async () => {
    const { GET } = await import('./route');
    const res = await GET(
      new Request('https://crm.example.com/api/whatsapp/meta/webhook')
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe('meta');
    expect(JSON.stringify(body)).not.toContain(APP_SECRET);
  });
});

describe('POST — signature verification', () => {
  it('processes a correctly signed callback', async () => {
    const payload = messagePayload();
    const body = JSON.stringify(payload);
    const { POST } = await import('./route');

    const res = await POST(post(payload, sign(body)));
    expect(res.status).toBe(200);

    // Work happens in after(), so nothing has run yet.
    expect(h.processMessage).not.toHaveBeenCalled();
    await runAfterCallbacks();

    expect(h.processMessage).toHaveBeenCalledTimes(1);
    const [message, accountId, userId, channel] =
      h.processMessage.mock.calls[0];
    expect(message).toMatchObject({ id: 'wamid.ABC', text: 'hello' });
    expect(accountId).toBe('acc-1');
    expect(userId).toBe('user-1');
    // The pipeline stamps messages.provider from this.
    expect(channel).toMatchObject({
      provider: 'meta',
      accountId: 'acc-1',
      phoneNumberId: '109876543210',
      accessToken: 'meta-token',
    });
  });

  it('rejects a callback with a bad signature and runs nothing', async () => {
    const payload = messagePayload();
    const { POST } = await import('./route');

    const res = await POST(
      post(payload, sign(JSON.stringify(payload), 'wrong-secret'))
    );
    expect(res.status).toBe(401);
    await runAfterCallbacks();
    expect(h.processMessage).not.toHaveBeenCalled();
  });

  it('rejects a callback with no signature header at all', async () => {
    const { POST } = await import('./route');
    const res = await POST(post(messagePayload(), null));
    expect(res.status).toBe(401);
    await runAfterCallbacks();
    expect(h.processMessage).not.toHaveBeenCalled();
  });

  it('rejects when the body was altered after signing', async () => {
    // Signature is over the exact bytes; a tampered body must not pass.
    const original = JSON.stringify(messagePayload());
    const signature = sign(original);
    const tampered = JSON.parse(original);
    tampered.entry[0].changes[0].value.messages[0].text.body =
      'transfer $10000';

    const { POST } = await import('./route');
    const res = await POST(post(tampered, signature));
    expect(res.status).toBe(401);
  });
});

describe('POST — tenancy', () => {
  it('ignores (200) a payload for a phone number id we do not have', async () => {
    h.state.metaConfigs = [];
    const payload = messagePayload('999999999');
    const { POST } = await import('./route');

    const res = await POST(post(payload, sign(JSON.stringify(payload))));
    // 200, not 4xx: Meta retries failures and eventually disables the
    // subscription, and this payload will never become deliverable.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ignored' });
    await runAfterCallbacks();
    expect(h.processMessage).not.toHaveBeenCalled();
  });

  it('ignores a payload carrying no phone_number_id', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [] }],
    };
    const { POST } = await import('./route');
    const res = await POST(post(payload, sign(JSON.stringify(payload))));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ignored' });
  });

  it('rejects malformed JSON before doing anything else', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      new Request('https://crm.example.com/api/whatsapp/meta/webhook', {
        method: 'POST',
        body: 'not json',
      })
    );
    expect(res.status).toBe(400);
  });
});

describe('POST — delivery statuses and template callbacks', () => {
  it('forwards statuses to the shared ladder handler', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'W1',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '109876543210' },
                statuses: [
                  {
                    id: 'wamid.OUT',
                    status: 'delivered',
                    timestamp: '1712995245',
                    recipient_id: '15551234567',
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const { POST } = await import('./route');
    await POST(post(payload, sign(JSON.stringify(payload))));
    await runAfterCallbacks();

    expect(h.handleStatusUpdate).toHaveBeenCalledTimes(1);
    expect(h.handleStatusUpdate.mock.calls[0][0]).toMatchObject({
      messageId: 'wamid.OUT',
      status: 'delivered',
    });
  });

  it('routes a template review result to the template handler, not the inbox', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'W1',
          changes: [
            {
              field: 'message_template_status_update',
              value: {
                event: 'APPROVED',
                message_template_name: 'order_update',
              },
            },
          ],
        },
      ],
    };
    const { POST } = await import('./route');
    const res = await POST(post(payload, sign(JSON.stringify(payload))));
    expect(res.status).toBe(200);
    await runAfterCallbacks();

    expect(h.handleTemplateWebhookChange).toHaveBeenCalledTimes(1);
    expect(h.processMessage).not.toHaveBeenCalled();
  });

  it('rejects an unsigned template callback', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        { changes: [{ field: 'message_template_status_update', value: {} }] },
      ],
    };
    const { POST } = await import('./route');
    const res = await POST(post(payload, 'sha256=deadbeef'));
    expect(res.status).toBe(401);
    await runAfterCallbacks();
    expect(h.handleTemplateWebhookChange).not.toHaveBeenCalled();
  });
});
