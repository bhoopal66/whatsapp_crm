import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageTemplate } from '@/types';

const metaSend = vi.fn();
const whapiSend = vi.fn();
const getChannelInfo = vi.fn();

// The real error classes (and `describeChannelStatus`) stay: the
// failure wording is chosen by `instanceof` and capability getters.
vi.mock('./meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTemplateMessage: (...args: unknown[]) => metaSend(...args),
}));
vi.mock('./whapi-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTemplateMessage: (...args: unknown[]) => whapiSend(...args),
  getChannelInfo: (...args: unknown[]) => getChannelInfo(...args),
}));

import {
  describeSendFailure,
  explainSendFailure,
  isChannelLevelFailure,
  isDefiniteSendRefusal,
  probeChannel,
  sendTemplate,
} from './provider';
import type { WhatsAppChannel } from './channels';
import { MetaError } from './meta-api';
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
