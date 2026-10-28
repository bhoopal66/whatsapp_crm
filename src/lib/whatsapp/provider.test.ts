import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageTemplate } from '@/types';

const metaSend = vi.fn();
const whapiSend = vi.fn();
const getChannelInfo = vi.fn();

// While a module is poisoned, every function it exports (bar the error
// classes) throws, so a test can prove an OpenWA channel never reaches
// the Whapi or Meta client — the bug an `else` branch used to hide.
const gate = vi.hoisted(() => {
  const poisoned = { whapi: false, meta: false };
  function guard(
    mod: 'whapi' | 'meta',
    exports: Record<string, unknown>
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(exports)) {
      // Classes (WhapiError, MetaError) stay real: `instanceof` decides
      // the failure wording.
      out[name] =
        typeof value === 'function' && !/^[A-Z]/.test(name)
          ? (...args: unknown[]) => {
              if (poisoned[mod]) throw new Error(`${mod}.${name} was called`);
              return (value as (...a: unknown[]) => unknown)(...args);
            }
          : value;
    }
    return out;
  }
  return { poisoned, guard };
});

const openwaMock = vi.hoisted(() => ({
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  sendTemplateMessage: vi.fn(),
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
  sendReactionMessage: vi.fn(),
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
  getContactProfilePicture: vi.fn(),
  getSession: vi.fn(),
}));

// The real error classes (and `describeChannelStatus`) stay: the
// failure wording is chosen by `instanceof` and capability getters.
vi.mock('./meta-api', async (importOriginal) =>
  gate.guard('meta', {
    ...(await importOriginal<Record<string, unknown>>()),
    sendTemplateMessage: (...args: unknown[]) => metaSend(...args),
  })
);
vi.mock('./whapi-api', async (importOriginal) =>
  gate.guard('whapi', {
    ...(await importOriginal<Record<string, unknown>>()),
    sendTemplateMessage: (...args: unknown[]) => whapiSend(...args),
    getChannelInfo: (...args: unknown[]) => getChannelInfo(...args),
  })
);
vi.mock('./openwa-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...openwaMock,
}));

import {
  describeSendFailure,
  downloadMedia,
  explainSendFailure,
  getContactProfilePicture,
  getMediaUrl,
  getNumberSafetyRating,
  isChannelLevelFailure,
  isDefiniteSendRefusal,
  probeChannel,
  sendInteractiveButtons,
  sendInteractiveList,
  sendMedia,
  sendReaction,
  sendTemplate,
  sendText,
} from './provider';
import type { WhatsAppChannel } from './channels';
import { MetaError } from './meta-api';
import { OpenWAError } from './openwa-api';
import { WhapiError } from './whapi-api';

const template = {
  id: 't1',
  name: 'promo_video',
  language: 'en',
  header_type: 'video',
  header_media_url: null,
  body_text: 'Hello {{1}}',
  buttons: [],
} as unknown as MessageTemplate;

function channel(provider: 'meta' | 'whapi'): WhatsAppChannel {
  return {
    provider,
    phoneNumberId: 'pn-1',
    accessToken: 'tok',
  } as unknown as WhatsAppChannel;
}

describe('sendTemplate', () => {
  beforeEach(() => {
    metaSend.mockReset().mockResolvedValue({ messageId: 'wamid.1' });
    whapiSend.mockReset().mockResolvedValue({ messageId: 'whapi.1' });
  });

  it('forwards headerMediaUrl to Meta inside messageParams', async () => {
    // Regression: the Meta branch used to pass only `messageParams`
    // (which no caller sets) and drop `headerMediaUrl`, so a video
    // template synced from Meta — no header_media_url on the row —
    // failed every send with "requires a media link or id".
    await sendTemplate({
      channel: channel('meta'),
      to: '+14155550123',
      template,
      bodyParams: ['Jane'],
      headerMediaUrl: 'https://cdn.example.com/promo.mp4',
    });

    expect(metaSend).toHaveBeenCalledTimes(1);
    expect(metaSend.mock.calls[0][0]).toMatchObject({
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      to: '+14155550123',
      templateName: 'promo_video',
      language: 'en',
      params: ['Jane'],
      messageParams: { headerMediaUrl: 'https://cdn.example.com/promo.mp4' },
    });
  });

  it('keeps an explicit messageParams.headerMediaUrl over the top-level one', async () => {
    await sendTemplate({
      channel: channel('meta'),
      to: '+14155550123',
      template,
      headerMediaUrl: 'https://cdn.example.com/fallback.mp4',
      messageParams: { headerMediaUrl: 'https://cdn.example.com/explicit.mp4' },
    });

    expect(metaSend.mock.calls[0][0].messageParams).toEqual({
      headerMediaUrl: 'https://cdn.example.com/explicit.mp4',
    });
  });

  it('sends an empty messageParams when no override is given', async () => {
    await sendTemplate({
      channel: channel('meta'),
      to: '+14155550123',
      template,
    });

    expect(metaSend.mock.calls[0][0].messageParams).toEqual({});
  });

  it('forwards headerMediaUrl to Whapi unchanged', async () => {
    await sendTemplate({
      channel: channel('whapi'),
      to: '+14155550123',
      template,
      bodyParams: ['Jane'],
      headerMediaUrl: 'https://cdn.example.com/promo.mp4',
    });

    expect(metaSend).not.toHaveBeenCalled();
    expect(whapiSend.mock.calls[0][0]).toMatchObject({
      token: 'tok',
      headerMediaUrl: 'https://cdn.example.com/promo.mp4',
      bodyParams: ['Jane'],
    });
  });
});

describe('isChannelLevelFailure', () => {
  it('is true for the Whapi failures that break every send on the number', () => {
    expect(isChannelLevelFailure(new WhapiError('Unauthorized', 401))).toBe(
      true
    );
    expect(isChannelLevelFailure(new WhapiError('Forbidden', 403))).toBe(true);
    expect(
      isChannelLevelFailure(new WhapiError('Service not found', 404))
    ).toBe(true);
    expect(isChannelLevelFailure(new WhapiError('Payment required', 402))).toBe(
      true
    );
  });

  it('is true for a Meta auth failure', () => {
    expect(isChannelLevelFailure(new MetaError('expired', 401, 190))).toBe(
      true
    );
    expect(isChannelLevelFailure(new MetaError('oauth', 400, 190))).toBe(true);
  });

  it('is false for failures that belong to one recipient or one moment', () => {
    // A bad recipient, a closed 24h window, a rate limit, a gateway blip:
    // the next recipient may well succeed.
    expect(isChannelLevelFailure(new WhapiError('bad to', 400))).toBe(false);
    expect(isChannelLevelFailure(new WhapiError('timeout', 503))).toBe(false);
    expect(isChannelLevelFailure(new MetaError('window', 400, 131047))).toBe(
      false
    );
    expect(isChannelLevelFailure(new MetaError('slow down', 429, 4))).toBe(
      false
    );
    expect(isChannelLevelFailure(new Error('boom'))).toBe(false);
    expect(isChannelLevelFailure('nope')).toBe(false);
    expect(isChannelLevelFailure(null)).toBe(false);
  });
});

describe('isDefiniteSendRefusal', () => {
  it('is true for a gateway 4xx refusal: nothing went out', () => {
    for (const status of [400, 401, 402, 403, 404, 409, 429]) {
      expect(isDefiniteSendRefusal(new WhapiError('refused', status))).toBe(
        true
      );
    }
    expect(isDefiniteSendRefusal(new MetaError('window', 400, 131047))).toBe(
      true
    );
    expect(isDefiniteSendRefusal(new MetaError('expired', 401, 190))).toBe(
      true
    );
    // The Whapi client's own pre-request check.
    expect(
      isDefiniteSendRefusal(
        new WhapiError('sendMediaMessage requires a link.', 400)
      )
    ).toBe(true);
  });

  it('is false when the gateway may already have sent it', () => {
    // whapiRequest's network error or timeout.
    expect(
      isDefiniteSendRefusal(
        new WhapiError('Whapi request failed: The operation timed out.', 503)
      )
    ).toBe(false);
    // readSentMessageId: accepted, so certainly sent, but no id back.
    expect(
      isDefiniteSendRefusal(
        new WhapiError(
          'Whapi accepted the text message but returned no message id.',
          502
        )
      )
    ).toBe(false);
    // metaFetch's timeout.
    expect(
      isDefiniteSendRefusal(
        new MetaError('Meta Graph API did not respond within 30000ms.', 504)
      )
    ).toBe(false);
    expect(isDefiniteSendRefusal(new MetaError('oops', 500, 131000))).toBe(
      false
    );
    expect(isDefiniteSendRefusal(new WhapiError('timeout', 408))).toBe(false);
  });

  it('is false for anything that is not a gateway answer', () => {
    // A 2xx whose body is not JSON makes `response.json()` throw.
    expect(
      isDefiniteSendRefusal(new SyntaxError('Unexpected token < in JSON'))
    ).toBe(false);
    expect(isDefiniteSendRefusal(new TypeError('fetch failed'))).toBe(false);
    expect(isDefiniteSendRefusal(new Error('boom'))).toBe(false);
    // Duck-typed look-alikes do not count: only the gateway classes do.
    expect(isDefiniteSendRefusal({ status: 400 })).toBe(false);
    expect(isDefiniteSendRefusal(null)).toBe(false);
  });
});

function whapiChannel(wabaId: string | null = '971581842504'): WhatsAppChannel {
  return {
    id: 'cfg-1',
    accountId: 'acct-1',
    provider: 'whapi',
    label: null,
    phoneNumberId: 'NIGHTW-JJC9J',
    wabaId,
    accessToken: 'tok',
    appSecret: null,
    isPrimary: true,
    mirrorInboundMedia: true,
    status: 'connected',
  };
}

function health(status: string, phone: string | null = null) {
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

describe('probeChannel', () => {
  // A block body: returning the mock would make vitest call it as a
  // teardown hook.
  beforeEach(() => {
    getChannelInfo.mockReset();
  });

  it('reads Whapi /health without waking the channel, on a short deadline', async () => {
    getChannelInfo.mockResolvedValue(health('QR'));
    await expect(probeChannel(whapiChannel())).resolves.toEqual({
      status: 'QR',
      authorized: false,
      phone: null,
    });
    expect(getChannelInfo).toHaveBeenCalledWith({
      token: 'tok',
      wakeup: false,
      timeoutMs: 5000,
    });
  });

  it('has nothing to probe on a Meta number', async () => {
    await expect(probeChannel(channel('meta'))).resolves.toBeNull();
    expect(getChannelInfo).not.toHaveBeenCalled();
  });

  it('plumbs the deadline down to the request', async () => {
    const actual =
      await vi.importActual<typeof import('./whapi-api')>('./whapi-api');
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: { code: 4, text: 'AUTH' } }),
      }))
    );
    try {
      await actual.getChannelInfo({
        token: 't',
        wakeup: false,
        timeoutMs: 5000,
      });
      expect(timeout).toHaveBeenLastCalledWith(5000);
      await actual.getChannelInfo({ token: 't' });
      // Unchanged default for every other caller.
      expect(timeout).toHaveBeenLastCalledWith(30_000);
    } finally {
      timeout.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe('describeSendFailure — Whapi 401/403', () => {
  it('does not claim the token is bad, and keeps Whapi’s own words', () => {
    for (const status of [401, 403]) {
      const text = describeSendFailure(
        new WhapiError('Channel not auth', status)
      );
      expect(text).toContain(`HTTP ${status}: Channel not auth`);
      expect(text).toMatch(/usually the phone was logged out/);
      expect(text).toMatch(/Settings → Numbers & access/);
      expect(text).not.toMatch(/invalid or revoked/);
    }
  });
});

describe('describeSendFailure — Meta #131008', () => {
  it('names a blank template value and the fallback that fixes it', () => {
    const error = new MetaError(
      '(#131008) Required parameter is missing',
      400,
      131008
    );
    expect(error.isMissingParameter).toBe(true);
    const text = describeSendFailure(error);
    expect(text).toMatch(/missing or blank \(#131008\)/);
    expect(text).toMatch(/Meta rejects blank template values/);
    expect(text).not.toMatch(/broadcast|Personalize/i);
  });

  it('leaves other Meta codes alone', () => {
    const error = new MetaError('Something else', 400, 100);
    expect(error.isMissingParameter).toBe(false);
    expect(describeSendFailure(error)).toBe('Something else');
  });
});

describe('explainSendFailure', () => {
  beforeEach(() => {
    getChannelInfo.mockReset();
  });

  it('names a logged-out phone, who fixes it, and warns off a token re-save', async () => {
    getChannelInfo.mockResolvedValue(health('QR'));
    const text = await explainSendFailure(
      new WhapiError('Unauthorized', 401),
      whapiChannel()
    );
    expect(text).toMatch(/is logged out of WhatsApp/);
    expect(text).toContain('whoever holds +971581842504');
    expect(text).toContain('panel.whapi.cloud');
    expect(text).toMatch(/Do not re-save the token/);
  });

  it('still reads when the row has no display number', async () => {
    getChannelInfo.mockResolvedValue(health('QR'));
    const text = await explainSendFailure(
      new WhapiError('Unauthorized', 403),
      whapiChannel(null)
    );
    expect(text).toContain('whoever holds this number');
  });

  it('words a transitional state as such, not as a logout', async () => {
    // A channel starting or syncing after a re-pair also refuses sends.
    getChannelInfo.mockResolvedValue(health('LAUNCH'));
    const text = await explainSendFailure(
      new WhapiError('Unauthorized', 401),
      whapiChannel()
    );
    expect(text).toMatch(/not connected to WhatsApp \(status LAUNCH\)/);
    expect(text).toMatch(/starting up/);
    expect(text).not.toMatch(/logged out/);
  });

  it('says so when the number reports connected but the send was refused', async () => {
    getChannelInfo.mockResolvedValue(health('AUTH', '971581842504'));
    const text = await explainSendFailure(
      new WhapiError('Forbidden for this chat', 403),
      whapiChannel()
    );
    expect(text).toContain('HTTP 403: Forbidden for this chat');
    expect(text).toMatch(/reports connected/);
  });

  it('calls the token revoked only when the probe itself is refused', async () => {
    for (const status of [401, 403, 404]) {
      getChannelInfo.mockRejectedValueOnce(new WhapiError('nope', status));
      const text = await explainSendFailure(
        new WhapiError('Unauthorized', 401),
        whapiChannel()
      );
      expect(text).toMatch(/no longer accepts the token/);
      expect(text).toContain(`HTTP ${status}`);
    }
  });

  it('falls back to the neutral wording when the probe cannot answer', async () => {
    getChannelInfo.mockRejectedValue(
      new WhapiError('Whapi request failed: timeout', 503)
    );
    const text = await explainSendFailure(
      new WhapiError('Unauthorized', 401),
      whapiChannel()
    );
    expect(text).toBe(describeSendFailure(new WhapiError('Unauthorized', 401)));
  });

  it('does not probe for failures the error already explains', async () => {
    await explainSendFailure(new WhapiError('bad to', 400), whapiChannel());
    await explainSendFailure(new WhapiError('lapsed', 402), whapiChannel());
    await explainSendFailure(
      new MetaError('expired', 401, 190),
      channel('meta')
    );
    expect(getChannelInfo).not.toHaveBeenCalled();
    await expect(
      explainSendFailure(new WhapiError('lapsed', 402), whapiChannel())
    ).resolves.toMatch(/subscription has lapsed/);
  });
});

// ============================================================
// OpenWA
// ============================================================

function openwaChannel(): WhatsAppChannel {
  return {
    id: 'cfg-ow',
    accountId: 'acct-1',
    provider: 'openwa',
    label: null,
    phoneNumberId: 'sess-1',
    wabaId: '971501234567',
    accessToken: 'owa-key',
    appSecret: null,
    isPrimary: false,
    mirrorInboundMedia: true,
    status: 'connected',
  };
}

const owaCreds = { apiKey: 'owa-key', sessionId: 'sess-1' };

function owaSession(status: string, phone: string | null = null) {
  return { id: 'sess-1', status, phone, pushName: null, restriction: null };
}

function resetOpenwa() {
  for (const fn of Object.values(openwaMock)) fn.mockReset();
  for (const fn of [
    openwaMock.sendTextMessage,
    openwaMock.sendMediaMessage,
    openwaMock.sendTemplateMessage,
    openwaMock.sendInteractiveButtons,
    openwaMock.sendInteractiveList,
    openwaMock.sendReactionMessage,
  ]) {
    fn.mockResolvedValue({ messageId: 'owa.1' });
  }
  openwaMock.getMediaUrl.mockReturnValue({
    url: 'http://openwa.local/api/sessions/sess-1/messages/c/m/media',
    mimeType: 'application/octet-stream',
    fileSize: null,
  });
  openwaMock.downloadMedia.mockResolvedValue({
    buffer: Buffer.from('x'),
    contentType: 'image/jpeg',
  });
  openwaMock.getContactProfilePicture.mockResolvedValue(
    'https://pps.whatsapp.net/p.jpg'
  );
  openwaMock.getSession.mockResolvedValue(owaSession('ready', '971501234567'));
}

describe('OpenWA channels use the OpenWA client', () => {
  beforeEach(() => {
    resetOpenwa();
  });

  it('sendText', async () => {
    const res = await sendText({
      channel: openwaChannel(),
      to: '+971501111111',
      text: 'hi',
      quotedMessageId: 'q1',
    });
    expect(openwaMock.sendTextMessage).toHaveBeenCalledWith({
      ...owaCreds,
      to: '+971501111111',
      text: 'hi',
      quotedMessageId: 'q1',
    });
    expect(res).toEqual({ messageId: 'owa.1', provider: 'openwa' });
  });

  it('sendMedia passes the kind through (voice stays a voice note)', async () => {
    const res = await sendMedia({
      channel: openwaChannel(),
      to: '+971501111111',
      kind: 'voice',
      link: 'https://cdn.example.com/a.ogg',
      caption: 'c',
      filename: 'a.ogg',
    });
    expect(openwaMock.sendMediaMessage).toHaveBeenCalledWith({
      ...owaCreds,
      to: '+971501111111',
      kind: 'voice',
      link: 'https://cdn.example.com/a.ogg',
      caption: 'c',
      filename: 'a.ogg',
      quotedMessageId: undefined,
    });
    expect(res).toEqual({ messageId: 'owa.1', provider: 'openwa' });
  });

  it('sendTemplate renders the row locally, with no Meta messageParams', async () => {
    const res = await sendTemplate({
      channel: openwaChannel(),
      to: '+971501111111',
      template,
      bodyParams: ['Jane'],
      messageParams: { headerText: 'ignored' },
      headerMediaUrl: 'https://cdn.example.com/promo.mp4',
    });
    expect(openwaMock.sendTemplateMessage).toHaveBeenCalledWith({
      ...owaCreds,
      to: '+971501111111',
      template,
      bodyParams: ['Jane'],
      headerMediaUrl: 'https://cdn.example.com/promo.mp4',
      quotedMessageId: undefined,
    });
    expect(res).toEqual({ messageId: 'owa.1', provider: 'openwa' });
  });

  it('sendInteractiveButtons', async () => {
    const buttons = [{ id: 'y', title: 'Yes' }];
    const res = await sendInteractiveButtons({
      channel: openwaChannel(),
      to: '+971501111111',
      bodyText: 'Pick',
      footerText: 'f',
      buttons,
    });
    expect(openwaMock.sendInteractiveButtons).toHaveBeenCalledWith({
      ...owaCreds,
      to: '+971501111111',
      bodyText: 'Pick',
      headerText: undefined,
      footerText: 'f',
      buttons,
      quotedMessageId: undefined,
    });
    expect(res).toEqual({ messageId: 'owa.1', provider: 'openwa' });
  });

  it('sendInteractiveList', async () => {
    const sections = [{ title: 'S', rows: [{ id: 'r1', title: 'Row' }] }];
    const res = await sendInteractiveList({
      channel: openwaChannel(),
      to: '+971501111111',
      bodyText: 'Pick',
      buttonLabel: 'Open',
      sections,
    });
    expect(openwaMock.sendInteractiveList).toHaveBeenCalledWith({
      ...owaCreds,
      to: '+971501111111',
      bodyText: 'Pick',
      buttonLabel: 'Open',
      headerText: undefined,
      footerText: undefined,
      sections,
      quotedMessageId: undefined,
    });
    expect(res).toEqual({ messageId: 'owa.1', provider: 'openwa' });
  });

  it('sendReaction passes the chat, which OpenWA needs', async () => {
    const res = await sendReaction({
      channel: openwaChannel(),
      to: '+971501111111',
      targetMessageId: 'MSG1',
      emoji: '👍',
    });
    expect(openwaMock.sendReactionMessage).toHaveBeenCalledWith({
      ...owaCreds,
      to: '+971501111111',
      targetMessageId: 'MSG1',
      emoji: '👍',
    });
    expect(res).toEqual({ messageId: 'owa.1', provider: 'openwa' });
  });

  it('getMediaUrl addresses the session with the <chat>/<message> id', async () => {
    const res = await getMediaUrl({
      channel: openwaChannel(),
      mediaId: '971501111111@c.us/MSG1',
    });
    expect(openwaMock.getMediaUrl).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      mediaId: '971501111111@c.us/MSG1',
    });
    expect(res.url).toContain('/sessions/sess-1/');
  });

  it('downloadMedia presents the session key', async () => {
    const res = await downloadMedia({
      channel: openwaChannel(),
      downloadUrl: 'http://openwa.local/x/media',
    });
    expect(openwaMock.downloadMedia).toHaveBeenCalledWith({
      ...owaCreds,
      downloadUrl: 'http://openwa.local/x/media',
    });
    expect(res.contentType).toBe('image/jpeg');
  });

  it('getContactProfilePicture asks OpenWA, and passes its null through', async () => {
    await expect(
      getContactProfilePicture(openwaChannel(), '971501111111')
    ).resolves.toBe('https://pps.whatsapp.net/p.jpg');
    expect(openwaMock.getContactProfilePicture).toHaveBeenCalledWith({
      ...owaCreds,
      contactId: '971501111111',
      timeoutMs: 10_000,
    });

    openwaMock.getContactProfilePicture.mockResolvedValue(null);
    await expect(
      getContactProfilePicture(openwaChannel(), '971501111111')
    ).resolves.toBeNull();
  });

  it("probeChannel reports OpenWA's own status word, verbatim", async () => {
    await expect(probeChannel(openwaChannel())).resolves.toEqual({
      status: 'ready',
      authorized: true,
      phone: '971501234567',
    });
    expect(openwaMock.getSession).toHaveBeenCalledWith({
      ...owaCreds,
      timeoutMs: 5_000,
    });

    openwaMock.getSession.mockResolvedValue(owaSession('qr_ready'));
    await expect(probeChannel(openwaChannel())).resolves.toEqual({
      status: 'qr_ready',
      authorized: false,
      phone: null,
    });
  });

  it('getNumberSafetyRating is null: OpenWA has no Safety Meter', async () => {
    await expect(getNumberSafetyRating(openwaChannel())).resolves.toBeNull();
  });
});

describe('an OpenWA channel never reaches the Whapi or Meta client', () => {
  beforeEach(() => {
    resetOpenwa();
    gate.poisoned.whapi = true;
    gate.poisoned.meta = true;
    return () => {
      gate.poisoned.whapi = false;
      gate.poisoned.meta = false;
    };
  });

  it('the poison is live (a Whapi channel does reach it)', async () => {
    await expect(
      sendText({ channel: whapiChannel(), to: '+1', text: 'x' })
    ).rejects.toThrow('whapi.sendTextMessage was called');
  });

  it('every send, media, profile, probe and safety function', async () => {
    const ch = openwaChannel();
    const to = '+971501111111';
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['sendText', () => sendText({ channel: ch, to, text: 'x' })],
      [
        'sendMedia',
        () =>
          sendMedia({ channel: ch, to, kind: 'image', link: 'https://x/y' }),
      ],
      ['sendTemplate', () => sendTemplate({ channel: ch, to, template })],
      [
        'sendInteractiveButtons',
        () =>
          sendInteractiveButtons({
            channel: ch,
            to,
            bodyText: 'b',
            buttons: [{ id: 'a', title: 'A' }],
          }),
      ],
      [
        'sendInteractiveList',
        () =>
          sendInteractiveList({
            channel: ch,
            to,
            bodyText: 'b',
            buttonLabel: 'l',
            sections: [{ rows: [{ id: 'a', title: 'A' }] }],
          }),
      ],
      [
        'sendReaction',
        () =>
          sendReaction({ channel: ch, to, targetMessageId: 'm', emoji: '👍' }),
      ],
      ['getMediaUrl', () => getMediaUrl({ channel: ch, mediaId: 'c/m' })],
      [
        'downloadMedia',
        () => downloadMedia({ channel: ch, downloadUrl: 'http://x/media' }),
      ],
      ['getContactProfilePicture', () => getContactProfilePicture(ch, to)],
      ['probeChannel', () => probeChannel(ch)],
      ['getNumberSafetyRating', () => getNumberSafetyRating(ch)],
      [
        'explainSendFailure',
        () => explainSendFailure(new OpenWAError('not ready', 409), ch),
      ],
    ];
    for (const [name, call] of calls) {
      await expect(call(), name).resolves.not.toThrow();
    }
  });
});

describe('OpenWA failure interpretation', () => {
  const unauthorized = new OpenWAError('Unauthorized', 401);
  const forbidden = new OpenWAError('Forbidden', 403);
  const sessionGone = new OpenWAError('Session not found', 404);
  const messageGone = new OpenWAError('Message not found', 404, {
    route: 'message',
  });
  const notReady = new OpenWAError('Engine not ready', 409);
  const paced = new OpenWAError('Daily limit', 429, {
    code: 'SEND_PACING_LIMITED',
    retryAfterSeconds: 1790,
  });
  const pacedNoHint = new OpenWAError('Daily limit', 429, {
    code: 'SEND_PACING_LIMITED',
  });
  const throttled = new OpenWAError('Too many requests', 429);
  const notSupported = new OpenWAError('Polls are not supported', 501);
  const unreachable = new OpenWAError('OpenWA request failed: timeout', 503);
  const noId = new OpenWAError('no message id', 502);

  it('isChannelLevelFailure: auth, a missing session and pacing stop the number', () => {
    expect(isChannelLevelFailure(unauthorized)).toBe(true);
    expect(isChannelLevelFailure(forbidden)).toBe(true);
    expect(isChannelLevelFailure(sessionGone)).toBe(true);
    expect(isChannelLevelFailure(paced)).toBe(true);

    expect(isChannelLevelFailure(messageGone)).toBe(false);
    expect(isChannelLevelFailure(notReady)).toBe(false);
    expect(isChannelLevelFailure(throttled)).toBe(false);
    expect(isChannelLevelFailure(notSupported)).toBe(false);
    expect(isChannelLevelFailure(unreachable)).toBe(false);
  });

  it('isDefiniteSendRefusal: a 4xx (409 included) certainly did not send', () => {
    for (const err of [unauthorized, sessionGone, notReady, paced]) {
      expect(isDefiniteSendRefusal(err), String(err.status)).toBe(true);
    }
    for (const err of [
      notSupported,
      unreachable,
      noId,
      new OpenWAError('Request timeout', 408),
    ]) {
      expect(isDefiniteSendRefusal(err), String(err.status)).toBe(false);
    }
  });

  it('describeSendFailure names the fix', () => {
    expect(describeSendFailure(unauthorized)).toBe(
      "OpenWA no longer accepts this number's key or the session was deleted; reconnect it in Settings → WhatsApp."
    );
    expect(describeSendFailure(sessionGone)).toBe(
      describeSendFailure(unauthorized)
    );
    expect(describeSendFailure(notReady)).toBe(
      'The OpenWA number is not connected to WhatsApp right now (starting, or logged out on the phone); an admin should check Settings → WhatsApp.'
    );
    expect(describeSendFailure(unreachable)).toBe(
      describeSendFailure(notReady)
    );
    expect(describeSendFailure(paced)).toBe(
      "OpenWA's sending limits for this number have been reached; retry in about 30 minutes."
    );
    expect(describeSendFailure(pacedNoHint)).toBe(
      "OpenWA's sending limits for this number have been reached; retry later."
    );
    expect(describeSendFailure(notSupported)).toMatch(
      /not available on OpenWA numbers: Polls are not supported/
    );
    expect(describeSendFailure(throttled)).toBe('Too many requests');
  });
});

describe('explainSendFailure — OpenWA', () => {
  const notReady = () => new OpenWAError('Engine not ready', 409);

  beforeEach(() => {
    resetOpenwa();
  });

  it.each(['qr_ready', 'disconnected', 'failed'])(
    'a %s session is logged out: re-link with the QR',
    async (status) => {
      openwaMock.getSession.mockResolvedValue(owaSession(status));
      const text = await explainSendFailure(notReady(), openwaChannel());
      expect(text).toMatch(/is logged out of WhatsApp/);
      expect(text).toMatch(
        /re-link it by scanning the QR in Settings → WhatsApp/
      );
    }
  );

  it.each(['initializing', 'authenticating'])(
    'a %s session is starting: retry in a minute',
    async (status) => {
      openwaMock.getSession.mockResolvedValue(owaSession(status));
      const text = await explainSendFailure(notReady(), openwaChannel());
      expect(text).toMatch(/still starting up/);
      expect(text).toMatch(/Retry in a minute/);
    }
  );

  it('probes an auth failure too, once', async () => {
    openwaMock.getSession.mockResolvedValue(owaSession('disconnected'));
    await explainSendFailure(
      new OpenWAError('Unauthorized', 401),
      openwaChannel()
    );
    expect(openwaMock.getSession).toHaveBeenCalledTimes(1);
  });

  it('falls back to describeSendFailure when the probe errors', async () => {
    openwaMock.getSession.mockRejectedValue(
      new OpenWAError('Unauthorized', 401)
    );
    const err = notReady();
    await expect(explainSendFailure(err, openwaChannel())).resolves.toBe(
      describeSendFailure(err)
    );
  });

  it('does not probe for failures the error already explains', async () => {
    const paced = new OpenWAError('Daily limit', 429, {
      code: 'SEND_PACING_LIMITED',
    });
    await expect(explainSendFailure(paced, openwaChannel())).resolves.toBe(
      describeSendFailure(paced)
    );
    await explainSendFailure(new OpenWAError('nope', 501), openwaChannel());
    expect(openwaMock.getSession).not.toHaveBeenCalled();
  });
});
