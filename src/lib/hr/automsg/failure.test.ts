import { describe, expect, it, vi } from 'vitest';
import { MetaError } from '@/lib/whatsapp/meta-api';
import { OpenWAError, openwaRequest } from '@/lib/whatsapp/openwa-api';
import { WhapiError, sendTextMessage } from '@/lib/whatsapp/whapi-api';
import { HrSendRefusal, classifySendFailure } from './failure';

const meta = (status: number, code: number | null = null) =>
  new MetaError('m', status, code);

const unconfirmed = (reason: string) => ({
  retryable: false,
  reason,
  unconfirmed: true,
});

const socket = (code: string) => Object.assign(new Error(code), { code });
const fetchFailed = (code: string) =>
  new TypeError('fetch failed', { cause: socket(code) });
const named = (name: string) => Object.assign(new Error('t'), { name });

describe('classifySendFailure: Meta', () => {
  it.each([
    [131026, 'undeliverable'],
    [131047, 'reengagement_window'],
    [131009, 'invalid_number'],
    [131030, 'invalid_number'],
    [132001, 'template_not_found'],
    [132015, 'template_paused'],
    [132016, 'template_paused'],
    [132000, 'template_rejected'],
    [132012, 'template_rejected'],
  ])('code %i -> terminal %s', (code, reason) => {
    expect(classifySendFailure(meta(400, code))).toEqual({
      retryable: false,
      reason,
    });
  });

  it.each([
    [4, 'rate_limited'],
    [80007, 'rate_limited'],
    [130429, 'rate_limited'],
    [131048, 'rate_limited'],
    [131056, 'rate_limited'],
    [1, 'provider_unavailable'],
    [2, 'provider_unavailable'],
    [131000, 'provider_unavailable'],
    [131016, 'provider_unavailable'],
  ])('code %i on HTTP 400 -> retryable %s', (code, reason) => {
    expect(classifySendFailure(meta(400, code))).toEqual({
      retryable: true,
      reason,
    });
  });

  it.each([
    [401, false, 'unauthorized'],
    [403, false, 'unauthorized'],
    [400, false, 'rejected'],
    [404, false, 'rejected'],
    [429, true, 'rate_limited'],
  ])('HTTP %i -> retryable %s %s', (status, retryable, reason) => {
    expect(classifySendFailure(meta(status))).toEqual({ retryable, reason });
  });

  // 504 is metaFetch's own timeout.
  it.each([500, 503, 504])('HTTP %i may have been accepted', (status) => {
    expect(classifySendFailure(meta(status))).toEqual(
      unconfirmed('provider_unavailable')
    );
  });
});

describe('classifySendFailure: Whapi', () => {
  it.each([401, 403])('a %i is ambiguous, so retried', (status) => {
    expect(classifySendFailure(new WhapiError('w', status))).toEqual({
      retryable: true,
      reason: 'provider_unavailable',
    });
  });

  it('an unknown channel (404 Service not found) is terminal', () => {
    expect(
      classifySendFailure(new WhapiError('Service not found', 404))
    ).toEqual({ retryable: false, reason: 'unauthorized' });
  });

  it.each([
    [400, false, 'rejected'],
    [429, true, 'rate_limited'],
  ])('HTTP %i -> retryable %s %s', (status, retryable, reason) => {
    expect(classifySendFailure(new WhapiError('w', status))).toEqual({
      retryable,
      reason,
    });
  });

  it.each([502, 503])('a %i may have been accepted', (status) => {
    expect(classifySendFailure(new WhapiError('w', status))).toEqual(
      unconfirmed('provider_unavailable')
    );
  });
});

describe('classifySendFailure: OpenWA', () => {
  it.each([
    [
      'not ready (409)',
      new OpenWAError('o', 409),
      true,
      'provider_unavailable',
    ],
    [
      'not ready (503)',
      new OpenWAError('o', 503),
      true,
      'provider_unavailable',
    ],
    [
      'pacing',
      new OpenWAError('o', 429, { code: 'SEND_PACING_LIMITED' }),
      true,
      'provider_unavailable',
    ],
    ['other 429', new OpenWAError('o', 429), true, 'rate_limited'],
    ['auth', new OpenWAError('o', 401), false, 'unauthorized'],
    ['session gone', new OpenWAError('o', 404), false, 'unauthorized'],
    [
      'message 404',
      new OpenWAError('o', 404, { route: 'message' }),
      false,
      'rejected',
    ],
    ['other 4xx', new OpenWAError('o', 400), false, 'rejected'],
  ])('%s -> retryable %s %s', (_n, e, retryable, reason) => {
    expect(classifySendFailure(e)).toEqual({ retryable, reason });
  });

  it.each([500, 502, 504])('a %i may have been accepted', (status) => {
    expect(classifySendFailure(new OpenWAError('o', status))).toEqual(
      unconfirmed('provider_unavailable')
    );
  });
});

describe('classifySendFailure: transport and the rest', () => {
  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])(
    '%s reached nobody, so it is retried',
    (code) => {
      expect(classifySendFailure(fetchFailed(code))).toEqual({
        retryable: true,
        reason: 'network',
      });
    }
  );

  it('every address refused is retried; one that may have connected is not', () => {
    const many = (...codes: string[]) =>
      new TypeError('fetch failed', {
        cause: new AggregateError(codes.map(socket)),
      });
    expect(
      classifySendFailure(many('ECONNREFUSED', 'ECONNREFUSED')).retryable
    ).toBe(true);
    expect(classifySendFailure(many('ECONNREFUSED', 'ETIMEDOUT'))).toEqual(
      unconfirmed('network')
    );
  });

  it.each([
    new TypeError('fetch failed'),
    fetchFailed('ECONNRESET'),
    fetchFailed('UND_ERR_SOCKET'),
  ])('any other fetch failure may have been accepted', (e) => {
    expect(classifySendFailure(e)).toEqual(unconfirmed('network'));
  });

  it.each(['TimeoutError', 'AbortError'])(
    '%s may have been accepted',
    (name) => {
      expect(classifySendFailure(named(name))).toEqual(unconfirmed('timeout'));
    }
  );

  it.each([
    ['Whapi', () => new WhapiError('Whapi request failed', 503)],
    ['OpenWA', () => new OpenWAError('OpenWA request failed', 503)],
  ])(
    '%s: no answer is judged by its cause, not as a 503 from the gateway',
    (_n, make) => {
      const because = (cause: unknown) => Object.assign(make(), { cause });
      expect(classifySendFailure(because(named('TimeoutError')))).toEqual(
        unconfirmed('timeout')
      );
      expect(classifySendFailure(because(fetchFailed('ECONNRESET')))).toEqual(
        unconfirmed('network')
      );
      expect(classifySendFailure(because(fetchFailed('ECONNREFUSED')))).toEqual(
        { retryable: true, reason: 'network' }
      );
    }
  );

  it.each([
    [
      'Whapi',
      () => sendTextMessage({ token: 't', to: '971500000001', text: 'x' }),
    ],
    [
      'OpenWA',
      () =>
        openwaRequest({ apiKey: 'k', sessionId: 's', path: '/x', body: {} }),
    ],
  ])('%s keeps what fetch threw as the cause', async (_n, call) => {
    const thrown = named('TimeoutError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(thrown));
    const e = await call().catch((err: unknown) => err);
    vi.unstubAllGlobals();
    expect((e as Error).cause).toBe(thrown);
    expect(classifySendFailure(e)).toEqual(unconfirmed('timeout'));
  });

  it.each([new Error('boom'), 'a string', null])(
    'anything unknown may have been accepted (%s)',
    (e) => {
      expect(classifySendFailure(e)).toEqual(unconfirmed('error'));
    }
  );

  it('a local refusal carries its own reason and retryability', () => {
    expect(
      classifySendFailure(new HrSendRefusal('invalid_number', 'x'))
    ).toEqual({ retryable: false, reason: 'invalid_number' });
    expect(
      classifySendFailure(new HrSendRefusal('not_connected', 'x', true))
    ).toEqual({ retryable: true, reason: 'not_connected' });
  });
});
