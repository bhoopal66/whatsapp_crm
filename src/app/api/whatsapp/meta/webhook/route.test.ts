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
    /** Make one lookup answer a database error instead of rows. */
    failLookup: null as null | 'waba' | 'phone',
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
      // Honours eq/in, so a lookup by phone_number_id or waba_id only
      // finds the rows that really match — the tenancy tests rely on it.
      let rows = [...h.state.metaConfigs];
      let byWaba = false;
      const failure = { data: null, error: { message: 'connection lost' } };
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          rows = rows.filter((r) => r[col] === val);
          return b;
        },
        in: (col: string, vals: unknown[]) => {
          byWaba = true;
          rows = rows.filter((r) => vals.includes(r[col]));
          return b;
        },
        // The phone_number_id lookup.
        maybeSingle: async () =>
          h.state.failLookup === 'phone'
            ? failure
            : { data: rows[0] ?? null, error: null },
        // The WABA lookup and the verify-token / app-secret scans await
        // the builder directly; only the WABA lookup uses `in`.
        then: (resolve: (r: unknown) => unknown) =>
          resolve(
            byWaba && h.state.failLookup === 'waba'
              ? failure
              : { data: rows, error: null }
          ),
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
  vi.restoreAllMocks();
  vi.clearAllMocks();
  h.afterCallbacks.length = 0;
  h.state.metaConfigs = [CONFIG];
  h.state.failLookup = null;
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

  it('summarises dropped callbacks per id instead of logging every POST', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Unique to this test: the tally is module state and outlives a test.
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'OTHER_WABA',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '819779421230083' },
                messages: messagePayload().entry[0].changes[0].value.messages,
                statuses: [
                  { id: 'wamid.S1', status: 'sent', recipient_id: '1' },
                  { id: 'wamid.S2', status: 'read', recipient_id: '1' },
                ],
              },
            },
          ],
        },
      ],
    };
    // Signed with the app secret stored on the CONNECTED row, and no
    // environment secret: the tally says this app delivered it.
    delete process.env.META_APP_SECRET;
    const { POST } = await import('./route');

    const first = await POST(post(payload, sign(JSON.stringify(payload))));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: 'ignored' });
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      'dropped 1 callback for unconnected phone_number_id "819779421230083"'
    );
    expect(lines[0]).toContain(
      '1 message, 2 statuses (1/1 signed by this app)'
    );

    // Within the hour: still 200, but nothing more in the log.
    const second = await POST(post(payload, 'sha256=deadbeef'));
    expect(second.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
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

  it('ignores a non-string phone_number_id instead of throwing', async () => {
    // Read before any signature check. A number used to reach the drop
    // tally's slice() and throw: a 500 and a stack trace per POST.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const payload = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: { metadata: { phone_number_id: 12345 } },
            },
          ],
        },
      ],
    };
    const { POST } = await import('./route');
    const res = await POST(post(payload, null));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ignored' });
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      '[meta-webhook] callback carried no phone_number_id; ignoring',
    ]);
  });

  it.each([
    ['null', 'null'],
    ['an entry that is not an array', '{"entry":5}'],
    ['a null entry', '{"entry":[null]}'],
    ['a null change', '{"entry":[{"changes":[null]}]}'],
    ['changes that are not an array', '{"entry":[{"changes":5}]}'],
    [
      'an object entry id',
      '{"entry":[{"id":{"toString":null},"changes":[{"field":"message_template_status_update"}]}]}',
    ],
  ])('ignores a body with %s instead of throwing', async (_, body) => {
    // Read before any signature check: each of these threw on the
    // first property read — a 500 and a stack trace per forged POST.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { POST } = await import('./route');
    const res = await POST(
      new Request('https://crm.example.com/api/whatsapp/meta/webhook', {
        method: 'POST',
        body,
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ignored' });
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      '[meta-webhook] callback is not a webhook payload; ignoring',
    ]);
    expect(error).not.toHaveBeenCalled();
    await runAfterCallbacks();
    expect(h.processMessage).not.toHaveBeenCalled();
  });

  it('answers 503, not "not connected", when the number lookup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.state.failLookup = 'phone';
    const payload = messagePayload();
    const { POST } = await import('./route');

    const res = await POST(post(payload, sign(JSON.stringify(payload))));
    // A 200 here was never redelivered: the connected number's message
    // was lost, and the tally named it an "unconnected" number.
    expect(res.status).toBe(503);
    expect(String(error.mock.calls[0][0])).toContain('config lookup failed');
    expect(warn).not.toHaveBeenCalled();
    expect(h.afterCallbacks).toHaveLength(0);

    // Meta's retry, once the database answers again, goes through.
    h.state.failLookup = null;
    const retry = await POST(post(payload, sign(JSON.stringify(payload))));
    expect(retry.status).toBe(200);
    await runAfterCallbacks();
    expect(h.processMessage).toHaveBeenCalledTimes(1);
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
          id: CONFIG.waba_id,
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
    // Scoped to the account that owns the WABA.
    expect(h.handleTemplateWebhookChange.mock.calls[0][2]).toBe('acc-1');
    expect(h.processMessage).not.toHaveBeenCalled();
  });

  function templatePayload(wabaId: string) {
    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: wabaId,
          changes: [
            {
              field: 'message_template_status_update',
              value: { event: 'REJECTED', message_template_id: '777' },
            },
          ],
        },
      ],
    };
  }

  it("refuses a template callback signed with another tenant's secret", async () => {
    // The victim's WABA is connected with the victim's secret; the
    // attacker signs with their own (also stored) secret.
    h.state.metaConfigs = [
      { ...CONFIG, account_id: 'victim', app_secret: 'victim_secret' },
      {
        ...CONFIG,
        id: 'cfg-attacker',
        account_id: 'attacker',
        waba_id: 'ATTACKER_WABA',
        app_secret: 'attacker_secret',
      },
    ];
    const payload = templatePayload(CONFIG.waba_id);
    const { POST } = await import('./route');
    const res = await POST(
      post(payload, sign(JSON.stringify(payload), 'attacker_secret'))
    );
    expect(res.status).toBe(401);
    await runAfterCallbacks();
    expect(h.handleTemplateWebhookChange).not.toHaveBeenCalled();
  });

  it('applies an entry only to the account whose secret verified it', async () => {
    h.state.metaConfigs = [
      { ...CONFIG, account_id: 'victim', app_secret: 'victim_secret' },
      {
        ...CONFIG,
        id: 'cfg-attacker',
        account_id: 'attacker',
        waba_id: 'ATTACKER_WABA',
        app_secret: 'attacker_secret',
      },
    ];
    // Attacker's own WABA entry plus a smuggled entry for the victim's.
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        ...templatePayload('ATTACKER_WABA').entry,
        ...templatePayload(CONFIG.waba_id).entry,
      ],
    };
    const { POST } = await import('./route');
    const res = await POST(
      post(payload, sign(JSON.stringify(payload), 'attacker_secret'))
    );
    expect(res.status).toBe(200);
    await runAfterCallbacks();
    expect(h.handleTemplateWebhookChange).toHaveBeenCalledTimes(1);
    expect(h.handleTemplateWebhookChange.mock.calls[0][2]).toBe('attacker');
  });

  it('acknowledges but ignores a genuine callback for a WABA not connected here', async () => {
    h.state.metaConfigs = [];
    const payload = templatePayload('SOMEONE_ELSES_WABA');
    const { POST } = await import('./route');
    const res = await POST(post(payload, sign(JSON.stringify(payload))));
    expect(res.status).toBe(200);
    await runAfterCallbacks();
    expect(h.handleTemplateWebhookChange).not.toHaveBeenCalled();
  });

  it('rejects an unsigned template callback for a WABA connected here', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: CONFIG.waba_id,
          changes: [{ field: 'message_template_status_update', value: {} }],
        },
      ],
    };
    const { POST } = await import('./route');
    const res = await POST(post(payload, 'sha256=deadbeef'));
    expect(res.status).toBe(401);
    await runAfterCallbacks();
    expect(h.handleTemplateWebhookChange).not.toHaveBeenCalled();
  });

  it('acknowledges an unknown WABA without META_APP_SECRET, checking no signature', async () => {
    // Production keeps the app secret on the row and never sets the
    // environment variable. This used to verify against it anyway and
    // answer 401, which Meta retries until it disables the subscription.
    delete process.env.META_APP_SECRET;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const payload = templatePayload('SOMEONE_ELSES_WABA');
    const { POST } = await import('./route');
    const res = await POST(post(payload, sign(JSON.stringify(payload))));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ignored' });
    // No "[webhook] no Meta app secret available" — the verifier never ran.
    expect(error).not.toHaveBeenCalled();
    await runAfterCallbacks();
    expect(h.handleTemplateWebhookChange).not.toHaveBeenCalled();
  });

  it('acknowledges an unsigned callback for an unknown WABA, touching nothing', async () => {
    const payload = templatePayload('SOMEONE_ELSES_WABA');
    const { POST } = await import('./route');
    const res = await POST(post(payload, null));
    expect(res.status).toBe(200);
    await runAfterCallbacks();
    expect(h.handleTemplateWebhookChange).not.toHaveBeenCalled();
  });

  it.each([
    [
      'message_template_quality_update',
      { message_template_id: '777', new_quality_score: 'YELLOW' },
    ],
    [
      'message_template_components_update',
      { message_template_id: '777', message_template_name: 'order_update' },
    ],
  ])(
    'routes a %s-only callback to the template handler',
    async (field, value) => {
      // These carry no phone_number_id; they used to fall through to the
      // message path and be dropped as "no phone_number_id".
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{ id: CONFIG.waba_id, changes: [{ field, value }] }],
      };
      const { POST } = await import('./route');
      const res = await POST(post(payload, sign(JSON.stringify(payload))));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'received' });
      await runAfterCallbacks();

      expect(h.handleTemplateWebhookChange).toHaveBeenCalledTimes(1);
      const [change, , accountId] = h.handleTemplateWebhookChange.mock.calls[0];
      expect(change).toMatchObject({ field, value });
      expect(accountId).toBe('acc-1');
      expect(h.processMessage).not.toHaveBeenCalled();
    }
  );

  it('answers 503, not "ignored", when the WABA lookup fails', async () => {
    // As in production: the secret lives on the row, not the env.
    delete process.env.META_APP_SECRET;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.state.failLookup = 'waba';
    const payload = templatePayload(CONFIG.waba_id);
    const { POST } = await import('./route');

    const res = await POST(post(payload, sign(JSON.stringify(payload))));
    // "ignored" left the template PENDING until a manual sync.
    expect(res.status).toBe(503);
    expect(String(error.mock.calls[0][0])).toContain(
      'template WABA lookup failed'
    );
    await runAfterCallbacks();
    expect(h.handleTemplateWebhookChange).not.toHaveBeenCalled();
  });

  it('still ignores a WABA-level field that is not a template event', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: CONFIG.waba_id,
          changes: [{ field: 'account_update', value: { event: 'X' } }],
        },
      ],
    };
    const { POST } = await import('./route');
    const res = await POST(post(payload, sign(JSON.stringify(payload))));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ignored' });
    await runAfterCallbacks();
    expect(h.handleTemplateWebhookChange).not.toHaveBeenCalled();
  });
});

describe('POST — a batch mixing template changes and messages', () => {
  const qualityChange = {
    field: 'message_template_quality_update',
    value: { message_template_id: '777', new_quality_score: 'YELLOW' },
  };

  function mixedPayload(templateWabaId: string) {
    const messages = messagePayload();
    return {
      object: 'whatsapp_business_account',
      entry: [
        { ...messages.entry[0], id: CONFIG.waba_id },
        { id: templateWabaId, changes: [qualityChange] },
      ],
    };
  }

  it('processes both halves of a signed mixed body', async () => {
    const payload = mixedPayload(CONFIG.waba_id);
    const { POST } = await import('./route');
    const res = await POST(post(payload, sign(JSON.stringify(payload))));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'received' });
    await runAfterCallbacks();

    // The template change used to return early and take the customer's
    // message down with it, answered 200 and never redelivered.
    expect(h.processMessage).toHaveBeenCalledTimes(1);
    expect(h.processMessage.mock.calls[0][0]).toMatchObject({
      id: 'wamid.ABC',
    });
    expect(h.handleTemplateWebhookChange).toHaveBeenCalledTimes(1);
    expect(h.handleTemplateWebhookChange.mock.calls[0][0]).toMatchObject(
      qualityChange
    );
    expect(h.handleTemplateWebhookChange.mock.calls[0][2]).toBe('acc-1');
  });

  it('processes both kinds of change in one entry', async () => {
    const messages = messagePayload();
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: CONFIG.waba_id,
          changes: [...messages.entry[0].changes, qualityChange],
        },
      ],
    };
    const { POST } = await import('./route');
    const res = await POST(post(payload, sign(JSON.stringify(payload))));
    expect(res.status).toBe(200);
    await runAfterCallbacks();
    expect(h.processMessage).toHaveBeenCalledTimes(1);
    expect(h.handleTemplateWebhookChange).toHaveBeenCalledTimes(1);
  });

  it('keeps the messages when the template change is for a WABA not connected here', async () => {
    const payload = mixedPayload('CREDIT_REVIEW_WABA');
    const { POST } = await import('./route');
    const res = await POST(post(payload, sign(JSON.stringify(payload))));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'received' });
    await runAfterCallbacks();
    expect(h.processMessage).toHaveBeenCalledTimes(1);
    expect(h.handleTemplateWebhookChange).not.toHaveBeenCalled();
  });

  it('answers 401 when one half fails verification, still running the half that passed', async () => {
    // The template entry names another account's WABA, whose own secret
    // did not sign this body. Meta retries the 401; the verified half
    // is queued anyway, and replaying it is idempotent.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.state.metaConfigs = [
      CONFIG,
      {
        ...CONFIG,
        id: 'cfg-other',
        account_id: 'acc-2',
        phone_number_id: '555',
        waba_id: 'OTHER_WABA',
        app_secret: 'other_secret',
      },
    ];
    const payload = mixedPayload('OTHER_WABA');
    const { POST } = await import('./route');
    const res = await POST(post(payload, sign(JSON.stringify(payload))));
    expect(res.status).toBe(401);
    await runAfterCallbacks();
    expect(h.processMessage).toHaveBeenCalledTimes(1);
    expect(h.processMessage.mock.calls[0][1]).toBe('acc-1');
    expect(h.handleTemplateWebhookChange).not.toHaveBeenCalled();
  });

  it('answers 503 and runs neither half when a lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.state.failLookup = 'waba';
    const payload = mixedPayload(CONFIG.waba_id);
    const { POST } = await import('./route');
    const res = await POST(post(payload, sign(JSON.stringify(payload))));
    expect(res.status).toBe(503);
    await runAfterCallbacks();
    expect(h.processMessage).not.toHaveBeenCalled();
    expect(h.handleTemplateWebhookChange).not.toHaveBeenCalled();
  });
});
