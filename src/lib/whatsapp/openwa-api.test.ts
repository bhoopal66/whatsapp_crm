import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OpenWAError,
  createScopedKey,
  createSession,
  createWebhook,
  deleteSession,
  findScopedKeyIds,
  getQr,
  logoutSession,
  revokeKey,
  startSession,
  downloadMedia,
  getChatHistory,
  getContactPhone,
  getContactProfilePicture,
  listChats,
  getMediaUrl,
  getSession,
  renderOptionsText,
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendReactionMessage,
  sendTextMessage,
  toOpenWAChatId,
  toOpenWAMediaId,
  updateWebhookEvents,
} from './openwa-api';

const creds = { apiKey: 'key-1', sessionId: 'sess-1' };
/** A resolver that answers every name with one public address. */
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const fetchMock = vi.fn();

function json(status: number, body: unknown, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function unexpected(): never {
  throw new Error('expected the call to fail');
}
function asOpenWAError(e: unknown): OpenWAError {
  if (!(e instanceof OpenWAError)) throw e;
  return e;
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return {
    url: String(url),
    init: init as RequestInit,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
    headers: init?.headers as Record<string, string>,
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('OPENWA_URL', 'http://openwa.test:2785/');
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('recipients', () => {
  it('maps a stored phone to a c.us chat id', () => {
    expect(toOpenWAChatId('+971 50 000 5678')).toBe('971500005678@c.us');
    expect(toOpenWAChatId('971500005678@s.whatsapp.net')).toBe(
      '971500005678@c.us'
    );
    expect(toOpenWAChatId('123-456@g.us')).toBe('123-456@g.us');
  });
});

describe('request shape', () => {
  it('sends text with the scoped key to the session route', async () => {
    fetchMock.mockResolvedValue(json(201, { messageId: 'm1', timestamp: 1 }));
    const res = await sendTextMessage({
      ...creds,
      to: '+971500000001',
      text: 'hi',
      quotedMessageId: 'q1',
    });
    expect(res).toEqual({ messageId: 'm1' });
    const c = lastCall();
    expect(c.url).toBe(
      'http://openwa.test:2785/api/sessions/sess-1/messages/send-text'
    );
    expect(c.init.method).toBe('POST');
    expect(c.headers['X-API-Key']).toBe('key-1');
    expect(c.body).toEqual({
      chatId: '971500000001@c.us',
      text: 'hi',
      quotedMessageId: 'q1',
    });
  });

  it('sends media with a flat body per kind; voice is send-audio ptt', async () => {
    fetchMock.mockImplementation(async () => json(201, { messageId: 'm2' }));
    await sendMediaMessage({
      ...creds,
      to: '971500000001',
      kind: 'document',
      link: 'https://x.test/a.pdf',
      resolve: publicDns,
      caption: 'c',
      filename: 'a.pdf',
    });
    expect(lastCall().url).toMatch(/\/messages\/send-document$/);
    expect(lastCall().body).toEqual({
      chatId: '971500000001@c.us',
      url: 'https://x.test/a.pdf',
      caption: 'c',
      filename: 'a.pdf',
    });

    await sendMediaMessage({
      ...creds,
      to: '971500000001',
      kind: 'voice',
      link: 'https://x.test/v.ogg',
      resolve: publicDns,
      caption: 'dropped',
    });
    expect(lastCall().url).toMatch(/\/messages\/send-audio$/);
    expect(lastCall().body).toEqual({
      chatId: '971500000001@c.us',
      url: 'https://x.test/v.ogg',
      ptt: true,
    });

    await sendMediaMessage({
      ...creds,
      to: '971500000001',
      kind: 'image',
      link: 'data:image/png;base64,AAAA',
    });
    expect(lastCall().body).toEqual({
      chatId: '971500000001@c.us',
      base64: 'AAAA',
      mimetype: 'image/png',
    });
  });

  it('reacts with chat, message and emoji, returning the target id', async () => {
    fetchMock.mockResolvedValue(json(201, { success: true }));
    const res = await sendReactionMessage({
      ...creds,
      to: '971500000001',
      targetMessageId: 'tgt',
      emoji: '👍',
    });
    expect(res.messageId).toBe('tgt');
    expect(lastCall().url).toMatch(/\/messages\/react$/);
    expect(lastCall().body).toEqual({
      chatId: '971500000001@c.us',
      messageId: 'tgt',
      emoji: '👍',
    });
  });

  it('reads the session and the profile picture', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        id: 'sess-1',
        status: 'ready',
        phone: '+971 50',
        pushName: 'X',
      })
    );
    expect(await getSession(creds)).toMatchObject({
      status: 'ready',
      phone: '97150',
    });
    expect(lastCall().url).toBe('http://openwa.test:2785/api/sessions/sess-1');
    expect(lastCall().init.method).toBe('GET');

    fetchMock.mockResolvedValueOnce(json(200, { url: null }));
    expect(
      await getContactProfilePicture({ ...creds, contactId: '+97150' })
    ).toBeNull();
    expect(lastCall().url).toMatch(
      /\/contacts\/97150%40c\.us\/profile-picture$/
    );
  });

  it('builds the media URL and sends the key only to it', async () => {
    const { url } = getMediaUrl({
      sessionId: 'sess-1',
      mediaId: toOpenWAMediaId('97150@c.us', 'true_97150@c.us_ABC'),
    });
    expect(url).toBe(
      'http://openwa.test:2785/api/sessions/sess-1/messages/97150%40c.us/true_97150%40c.us_ABC/media'
    );
    fetchMock.mockResolvedValue(
      new Response('bytes', { headers: { 'content-type': 'image/jpeg' } })
    );
    const out = await downloadMedia({ ...creds, downloadUrl: url });
    expect(out.contentType).toBe('image/jpeg');
    expect(new Headers(lastCall().init.headers).get('x-api-key')).toBe('key-1');

    // Another path on the gateway is not trusted: refused by the SSRF
    // guard (loopback/private) rather than fetched with the key.
    await expect(
      downloadMedia({
        ...creds,
        downloadUrl: 'http://openwa.test:2785/api/sessions/sess-1/config',
      })
    ).rejects.toBeInstanceOf(OpenWAError);
  });
});

describe('media link guard', () => {
  const STORAGE = 'http://supabase.internal:8000';
  const send = (link: string, resolve = publicDns) =>
    sendMediaMessage({
      ...creds,
      to: '971500000001',
      kind: 'image',
      link,
      resolve,
    });
  async function refused(link: string, resolve = publicDns) {
    const err = asOpenWAError(
      await send(link, resolve).then(unexpected, (e) => e)
    );
    expect(err.status).toBe(400);
    expect(err.route).toBe('message');
    expect(err.isAuthError).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', STORAGE);
    fetchMock.mockImplementation(async () => json(201, { messageId: 'm9' }));
  });

  it('refuses a loopback IP literal before the gateway is called', async () => {
    await refused('https://127.0.0.1:8000/rest/v1/');
    await refused('https://[::1]/x.png');
  });

  it('refuses a private or metadata IP literal', async () => {
    await refused('https://10.1.2.3/x.png');
    await refused('https://169.254.169.254/latest/meta-data');
    await refused('https://100.64.0.1/x.png');
  });

  it('refuses a hostname that resolves to a private address', async () => {
    const resolve = vi.fn(async () => [{ address: '10.0.0.5', family: 4 }]);
    await refused('https://intranet.example.com/x.png', resolve);
    expect(resolve).toHaveBeenCalledWith('intranet.example.com');
  });

  it('refuses plain http, credentials and internal names', async () => {
    await refused('http://cdn.example.com/x.png');
    await refused('https://u:p@cdn.example.com/x.png');
    await refused('https://localhost/x.png');
    await refused('https://db.internal/x.png');
  });

  it('passes a public https host through as the url', async () => {
    await send('https://cdn.example.com/x.png');
    expect(lastCall().body).toEqual({
      chatId: '971500000001@c.us',
      url: 'https://cdn.example.com/x.png',
    });
  });

  it('passes our own public storage URL even though it resolves inward', async () => {
    const resolve = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
    const link = `${STORAGE}/storage/v1/object/public/chat-media/account-1/a.png`;
    await send(link, resolve);
    expect(lastCall().body.url).toBe(link);
    expect(resolve).not.toHaveBeenCalled();
    // The exemption is that path only, not the whole storage host.
    fetchMock.mockClear();
    await refused(`${STORAGE}/rest/v1/contacts`, resolve);
    // Encoded traversal a proxy could decode is not the storage path.
    await refused(
      `${STORAGE}/storage/v1/object/public/..%2f..%2f..%2frest/v1/contacts`,
      resolve
    );
    await refused(
      `${STORAGE}/storage/v1/object/public/%2E%2E/%2E%2E/rest/v1`,
      resolve
    );
  });

  it('refuses when the lookup fails, and mapped-IPv6 loopback', async () => {
    await refused(
      'https://cdn.example.com/x.png',
      vi.fn(async () => {
        throw new Error('ENOTFOUND');
      })
    );
    await refused('https://[::ffff:127.0.0.1]/x.png');
    await refused('https://host.docker.internal/x.png');
  });

  it('leaves a data: link alone (bytes, no fetch)', async () => {
    const resolve = vi.fn(publicDns);
    await send('data:image/png;base64,AAAA', resolve);
    expect(lastCall().body.base64).toBe('AAAA');
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('error mapping', () => {
  async function failWith(status: number, body: unknown, headers = {}) {
    fetchMock.mockResolvedValue(json(status, body, headers));
    return sendTextMessage({ ...creds, to: '1', text: 'x' }).then(
      unexpected,
      asOpenWAError
    );
  }

  it('maps each status class to its getter', async () => {
    expect((await failWith(401, { message: 'bad key' })).isAuthError).toBe(
      true
    );
    expect((await failWith(403, {})).isAuthError).toBe(true);
    const nf = await failWith(404, { message: 'Session not found' });
    expect(nf.isSessionNotFound).toBe(true);
    expect(nf.message).toBe('Session not found');
    expect((await failWith(409, {})).isNotReady).toBe(true);
    expect((await failWith(503, {})).isNotReady).toBe(true);
    expect((await failWith(501, {})).isNotSupported).toBe(true);
    const engine = await failWith(500, { code: 'ENGINE_PAGE_ERROR' });
    expect(engine.code).toBe('ENGINE_PAGE_ERROR');
    expect(engine.isNotReady).toBe(false);
    const v = await failWith(400, { message: ['a', 'b'] });
    expect(v.message).toBe('a; b');
  });

  it('carries pacing fields; a plain 429 is not pacing', async () => {
    const p = await failWith(429, {
      statusCode: 429,
      code: 'SEND_PACING_LIMITED',
      retryAfterSeconds: 900,
    });
    expect(p.isPacingLimited).toBe(true);
    expect(p.retryAfterSeconds).toBe(900);
    const r = await failWith(429, {}, { 'retry-after': '5' });
    expect(r.isPacingLimited).toBe(false);
    expect(r.retryAfterSeconds).toBe(5);
  });

  it('a 404 on a message route is not a missing session', async () => {
    fetchMock.mockResolvedValue(json(404, {}));
    const err = await downloadMedia({
      ...creds,
      downloadUrl: getMediaUrl({ sessionId: 'sess-1', mediaId: 'c@c.us/m' })
        .url,
    }).then(unexpected, asOpenWAError);
    expect(err.status).toBe(404);
    expect(err.isSessionNotFound).toBe(false);
  });

  it('a network error or timeout becomes a synthetic 503', async () => {
    fetchMock.mockRejectedValue(
      new DOMException('The operation timed out.', 'TimeoutError')
    );
    const err = await sendTextMessage({ ...creds, to: '1', text: 'x' }).then(
      unexpected,
      asOpenWAError
    );
    expect(err).toBeInstanceOf(OpenWAError);
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/timed out/);
  });

  it('refuses a missing key before any request', async () => {
    const err = await sendTextMessage({
      apiKey: '',
      sessionId: 's',
      to: '1',
      text: 'x',
    }).then(unexpected, asOpenWAError);
    expect(err.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 201 without a message id is a 502', async () => {
    fetchMock.mockResolvedValue(json(201, {}));
    const err = await sendTextMessage({ ...creds, to: '1', text: 'x' }).then(
      unexpected,
      asOpenWAError
    );
    expect(err.status).toBe(502);
  });
});

describe('interactive fallback', () => {
  it('renders header, body, numbered options and footer', () => {
    expect(
      renderOptionsText({
        headerText: 'H',
        bodyText: 'Pick one',
        footerText: 'F',
        options: [{ title: 'Yes' }, { title: 'No' }],
      })
    ).toBe('H\n\nPick one\n\n1. Yes\n2. No\n\nF');
  });

  it('sends buttons as numbered text and returns the id', async () => {
    fetchMock.mockResolvedValue(json(201, { messageId: 'b1' }));
    const res = await sendInteractiveButtons({
      ...creds,
      to: '1',
      bodyText: 'Pick',
      buttons: [
        { id: 'y', title: 'Yes' },
        { id: 'n', title: 'No' },
      ],
    });
    expect(res.messageId).toBe('b1');
    expect(lastCall().url).toMatch(/\/send-text$/);
    expect(lastCall().body.text).toBe('Pick\n\n1. Yes\n2. No');
  });

  it('sends a list numbered across sections, without the button label', async () => {
    fetchMock.mockResolvedValue(json(201, { messageId: 'l1' }));
    await sendInteractiveList({
      ...creds,
      to: '1',
      bodyText: 'Menu',
      buttonLabel: 'Open',
      sections: [
        { title: 'A', rows: [{ id: 'a1', title: 'One', description: 'd' }] },
        { title: 'B', rows: [{ id: 'b1', title: 'Two' }] },
      ],
    });
    const { body } = lastCall();
    expect(body.text).toBe('Menu\n\n*A*\n1. One — d\n*B*\n2. Two');
    expect(body).not.toHaveProperty('buttonLabel');
  });
});

describe('provisioning', () => {
  it('creates a session on the gateway-wide route with the admin key', async () => {
    fetchMock.mockImplementation(async () =>
      json(201, { id: 'sess-9', status: 'created' })
    );
    await expect(
      createSession({ adminKey: 'admin-1', name: 'wacrm-abc' })
    ).resolves.toEqual({ id: 'sess-9', status: 'created' });
    const call = lastCall();
    expect(call.url).toBe('http://openwa.test:2785/api/sessions');
    expect(call.init.method).toBe('POST');
    expect(call.headers['X-API-Key']).toBe('admin-1');
    expect(call.body).toEqual({ name: 'wacrm-abc' });
  });

  it('surfaces a taken name as a 409 OpenWAError', async () => {
    fetchMock.mockImplementation(async () =>
      json(409, { statusCode: 409, message: 'Session name taken' })
    );
    const err = await createSession({ adminKey: 'a', name: 'dup' }).then(
      unexpected,
      asOpenWAError
    );
    expect(err.status).toBe(409);
    expect(err.message).toBe('Session name taken');
  });

  it('mints an operator key scoped to the one session', async () => {
    fetchMock.mockImplementation(async () =>
      json(201, { id: 'key-7', apiKey: 'owa_secret' })
    );
    await expect(
      createScopedKey({ adminKey: 'admin-1', sessionId: 'sess-9' })
    ).resolves.toEqual({ id: 'key-7', apiKey: 'owa_secret' });
    const call = lastCall();
    expect(call.url).toBe('http://openwa.test:2785/api/auth/api-keys');
    expect(call.body).toEqual({
      name: 'wacrm-sess-9',
      role: 'operator',
      allowedSessions: ['sess-9'],
    });
  });

  it('refuses a key response without the key itself', async () => {
    fetchMock.mockImplementation(async () => json(201, { id: 'key-7' }));
    const err = await createScopedKey({ adminKey: 'a', sessionId: 's' }).then(
      unexpected,
      asOpenWAError
    );
    expect(err.status).toBe(502);
  });

  it('registers the webhook with every event and the secret', async () => {
    fetchMock.mockImplementation(async () => json(201, { id: 'wh-1' }));
    const url = 'http://host.docker.internal:3000/api/whatsapp/openwa/webhook';
    await createWebhook({
      adminKey: 'admin-1',
      sessionId: 'sess-9',
      url,
      secret: 'f'.repeat(64),
    });
    const call = lastCall();
    expect(call.url).toBe(
      'http://openwa.test:2785/api/sessions/sess-9/webhooks'
    );
    expect(call.body).toEqual({
      url,
      events: [
        'message.received',
        'message.sent',
        'message.ack',
        'message.failed',
        'session.status',
        'group.join',
        'group.leave',
        'group.join_request',
        'group.update',
      ],
      secret: 'f'.repeat(64),
    });
  });

  it('starts, logs out, deletes and revokes on the right routes', async () => {
    fetchMock.mockImplementation(
      async () => new Response(null, { status: 204 })
    );
    const base = 'http://openwa.test:2785/api';
    await startSession({ adminKey: 'a', sessionId: 'sess-9' });
    expect(lastCall().url).toBe(`${base}/sessions/sess-9/start`);
    await logoutSession({ adminKey: 'a', sessionId: 'sess-9' });
    expect(lastCall().url).toBe(`${base}/sessions/sess-9/logout`);
    await deleteSession({ adminKey: 'a', sessionId: 'sess-9' });
    expect(lastCall().init.method).toBe('DELETE');
    expect(lastCall().url).toBe(`${base}/sessions/sess-9`);
    await revokeKey({ adminKey: 'a', keyId: 'key-7' });
    expect(lastCall().url).toBe(`${base}/auth/api-keys/key-7/revoke`);
    expect(lastCall().init.method).toBe('POST');
  });

  it('passes on only an image data URL as the QR', async () => {
    fetchMock.mockImplementation(async () =>
      json(200, { qrCode: 'data:image/png;base64,AAA', status: 'qr_ready' })
    );
    await expect(getQr(creds)).resolves.toEqual({
      qrCode: 'data:image/png;base64,AAA',
      status: 'qr_ready',
    });
    expect(lastCall().headers['X-API-Key']).toBe('key-1');
    fetchMock.mockImplementation(async () =>
      json(200, { qrCode: 'javascript:alert(1)', status: 'qr_ready' })
    );
    await expect(getQr(creds)).resolves.toMatchObject({ qrCode: null });
  });

  it('finds the active keys minted for a session by name', async () => {
    fetchMock.mockImplementation(async () =>
      json(200, [
        { id: 'k1', name: 'wacrm-sess-9', isActive: true },
        { id: 'k2', name: 'wacrm-sess-9', isActive: false },
        { id: 'k3', name: 'wacrm-sess-1', isActive: true },
      ])
    );
    await expect(
      findScopedKeyIds({ adminKey: 'a', sessionId: 'sess-9' })
    ).resolves.toEqual(['k1']);
  });
});

describe('phone history', () => {
  it('lists a page of chats by limit and offset, dropping id-less rows', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, [
        {
          id: '971501234567@c.us',
          name: 'Ali',
          kind: 'individual',
          isGroup: false,
          timestamp: 1700000000,
        },
        { id: '1203@g.us', kind: 'group', isGroup: true },
        { name: 'no id' },
      ])
    );
    const chats = await listChats({ ...creds, limit: 1000, offset: 2000 });
    expect(lastCall().url).toBe(
      'http://openwa.test:2785/api/sessions/sess-1/chats?limit=1000&offset=2000'
    );
    expect(lastCall().headers['X-API-Key']).toBe('key-1');
    expect(chats).toEqual([
      {
        id: '971501234567@c.us',
        name: 'Ali',
        kind: 'individual',
        isGroup: false,
        timestamp: 1700000000,
      },
      {
        id: '1203@g.us',
        name: null,
        kind: 'group',
        isGroup: true,
        timestamp: null,
      },
    ]);
  });

  it('reads a deep history with the caller timeout', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, [{ id: 'm1', body: 'hi', type: 'text' }, { body: 'x' }])
    );
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const rows = await getChatHistory({
      ...creds,
      chatId: '123@lid',
      limit: 500,
      deep: true,
      timeoutMs: 40_000,
    });
    expect(lastCall().url).toBe(
      'http://openwa.test:2785/api/sessions/sess-1/messages/123%40lid/history?limit=500&deep=true'
    );
    expect(timeout).toHaveBeenCalledWith(40_000);
    expect(rows).toEqual([{ id: 'm1', body: 'hi', type: 'text' }]);
    timeout.mockRestore();
  });

  it('maps a gateway 5xx on history to an OpenWAError', async () => {
    fetchMock.mockResolvedValueOnce(json(504, {}));
    const err = await getChatHistory({ ...creds, chatId: 'a@c.us', limit: 1 })
      .then(unexpected)
      .catch(asOpenWAError);
    expect(err.status).toBe(504);
  });

  it('resolves a contact id to phone digits, or null', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { contactId: '123@lid', phone: '+971 50 123' })
    );
    await expect(
      getContactPhone({ ...creds, contactId: '123@lid' })
    ).resolves.toBe('97150123');
    expect(lastCall().url).toBe(
      'http://openwa.test:2785/api/sessions/sess-1/contacts/123%40lid/phone'
    );
    fetchMock.mockResolvedValueOnce(
      json(200, { contactId: '123@lid', phone: null })
    );
    await expect(
      getContactPhone({ ...creds, contactId: '123@lid' })
    ).resolves.toBeNull();
  });
});

describe('updateWebhookEvents', () => {
  const HOOK_URL = 'https://crm.example.com/api/whatsapp/openwa/webhook';
  const ALL = [
    'message.received',
    'message.sent',
    'message.ack',
    'message.failed',
    'session.status',
    'group.join',
    'group.leave',
    'group.join_request',
    'group.update',
  ];

  it('makes no PUT when nothing is missing', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, [{ id: 'wh-1', url: HOOK_URL, events: ALL }])
    );
    await expect(updateWebhookEvents(creds)).resolves.toBe('unchanged');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastCall().init.method ?? 'GET').toBe('GET');
  });

  it('PUTs the merged list when message.sent is missing', async () => {
    const have = ['message.received', 'message.ack', 'custom.event'];
    fetchMock
      .mockResolvedValueOnce(
        json(200, [{ id: 'wh-1', url: HOOK_URL, events: have }])
      )
      .mockResolvedValueOnce(json(200, {}));
    await expect(updateWebhookEvents(creds)).resolves.toBe('updated');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const c = lastCall();
    expect(c.init.method).toBe('PUT');
    expect(c.url).toMatch(/\/webhooks\/wh-1$/);
    expect(c.body.events).toEqual([
      ...have,
      'message.sent',
      'message.failed',
      'session.status',
      'group.join',
      'group.leave',
      'group.join_request',
      'group.update',
    ]);
  });
});
