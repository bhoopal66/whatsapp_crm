import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OpenWAError,
  downloadMedia,
  getContactProfilePicture,
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
} from './openwa-api';

const creds = { apiKey: 'key-1', sessionId: 'sess-1' };
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
    expect(toOpenWAChatId('+971 55 823 3531')).toBe('971558233531@c.us');
    expect(toOpenWAChatId('971558233531@s.whatsapp.net')).toBe(
      '971558233531@c.us'
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
