import { describe, expect, it } from 'vitest';
import { MetaError } from '@/lib/whatsapp/meta-api';
import { OpenWAError } from '@/lib/whatsapp/openwa-api';
import { WhapiError } from '@/lib/whatsapp/whapi-api';
import { HrSendRefusal, classifySendFailure } from './failure';

const meta = (status: number, code: number | null = null) =>
  new MetaError('m', status, code);

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
    [500, true, 'provider_unavailable'],
    [503, true, 'provider_unavailable'],
  ])('HTTP %i -> retryable %s %s', (status, retryable, reason) => {
    expect(classifySendFailure(meta(status))).toEqual({ retryable, reason });
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
    [502, true, 'provider_unavailable'],
  ])('HTTP %i -> retryable %s %s', (status, retryable, reason) => {
    expect(classifySendFailure(new WhapiError('w', status))).toEqual({
      retryable,
      reason,
    });
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
    ['5xx', new OpenWAError('o', 500), true, 'provider_unavailable'],
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
});

describe('classifySendFailure: transport and the rest', () => {
  it('a fetch failure is a retryable network error', () => {
    expect(classifySendFailure(new TypeError('fetch failed'))).toEqual({
      retryable: true,
      reason: 'network',
    });
  });

  it.each(['TimeoutError', 'AbortError'])(
    '%s is a retryable timeout',
    (name) => {
      const e = new Error('t');
      e.name = name;
      expect(classifySendFailure(e)).toEqual({
        retryable: true,
        reason: 'timeout',
      });
    }
  );

  it.each([new Error('boom'), 'a string', null])(
    'anything unknown stays retryable (%s)',
    (e) => {
      expect(classifySendFailure(e)).toEqual({
        retryable: true,
        reason: 'error',
      });
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
