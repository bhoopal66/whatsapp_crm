/**
 * The host's existing Meta verifier (`verifyMetaWebhookSignature`) is the
 * signature check in front of the edge guards. These tests state the
 * security properties the edge package expects of a webhook verifier and
 * prove the existing one has them, without changing it: HMAC-SHA256 over
 * the raw body, a strict `sha256=<hex>` header, a constant-time compare,
 * and fail-closed when no secret is configured.
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyMetaWebhookSignature as verify } from '@/lib/whatsapp/webhook-signature';

// vitest.config.ts sets META_APP_SECRET to this; it is stubbed again below
// so the tests do not depend on the ambient value.
const ENV_SECRET = 'test_app_secret';
const ACCOUNT_SECRET = 'account_app_secret';
const BODY = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: '1', changes: [{ field: 'messages', value: {} }] }],
});

const hmacHex = (body: string, secret: string, algo = 'sha256') =>
  crypto.createHmac(algo, secret).update(body).digest('hex');
const sign = (body: string, secret = ENV_SECRET) =>
  `sha256=${hmacHex(body, secret)}`;
/** Same length, different last character. */
const flipLast = (s: string) => s.slice(0, -1) + (s.endsWith('0') ? '1' : '0');

beforeEach(() => {
  vi.stubEnv('META_APP_SECRET', ENV_SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a valid signature', () => {
  it('passes with the environment secret', () => {
    expect(verify(BODY, sign(BODY))).toBe(true);
  });

  it('passes with an explicit per-account secret', () => {
    expect(verify(BODY, sign(BODY, ACCOUNT_SECRET), ACCOUNT_SECRET)).toBe(true);
  });

  it('passes for a body with multi-byte UTF-8 (the HMAC is over its bytes)', () => {
    const body = JSON.stringify({ text: { body: 'مرحبا 👋 — café' } });
    expect(verify(body, sign(body))).toBe(true);
  });
});

describe('known answers', () => {
  it('matches a fixed Meta-shaped payload, secret and digest', () => {
    const body =
      '{"object":"whatsapp_business_account","entry":[{"id":"1234567890","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"phone_number_id":"1000000000"},"messages":[{"id":"wamid.KNOWN","type":"text","text":{"body":"hello"}}]}}]}]}';
    const digest =
      'c668e7c8de3c80082b23df1e9576e98944f7127476a6b61f268b73312e5e1543';
    expect(verify(body, `sha256=${digest}`, 'known_vector_secret')).toBe(true);
    expect(verify(`${body} `, `sha256=${digest}`, 'known_vector_secret')).toBe(
      false
    );
    expect(verify(body, `sha256=${digest}`, 'another_secret')).toBe(false);
  });

  it('is HMAC-SHA256 as published (RFC 4231 test case 2)', () => {
    expect(
      verify(
        'what do ya want for nothing?',
        'sha256=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
        'Jefe'
      )
    ).toBe(true);
  });
});

describe('a body that is not what was signed', () => {
  it.each([
    ['an appended character', `${BODY} `],
    ['a changed character', BODY.replace('"1"', '"2"')],
    ['an injected entry', BODY.replace('"entry":[', '"entry":[{"id":"x"},')],
    ['an empty body', ''],
  ])('is rejected: %s', (_name, tampered) => {
    expect(verify(tampered, sign(BODY))).toBe(false);
  });

  it('is rejected when it is the same JSON re-serialised (the HMAC is over the raw bytes)', () => {
    const raw = '{ "object": "whatsapp_business_account", "entry": [] }';
    const reserialised = JSON.stringify(JSON.parse(raw));
    expect(reserialised).not.toBe(raw);
    expect(verify(raw, sign(raw))).toBe(true);
    expect(verify(reserialised, sign(raw))).toBe(false);
  });

  it('is rejected when signed with another secret', () => {
    expect(verify(BODY, sign(BODY, 'someone_elses_secret'))).toBe(false);
    expect(verify(BODY, sign(BODY), ACCOUNT_SECRET)).toBe(false);
  });
});

describe('a header that is missing or not a sha256 signature', () => {
  it.each([
    ['null', null],
    ['an empty string', ''],
  ])('%s is rejected', (_name, h) => {
    expect(verify(BODY, h)).toBe(false);
  });

  it.each([
    [
      'sha1= with an HMAC-SHA1 digest',
      `sha1=${hmacHex(BODY, ENV_SECRET, 'sha1')}`,
    ],
    [
      'sha1= with the correct SHA-256 digest',
      `sha1=${hmacHex(BODY, ENV_SECRET)}`,
    ],
    [
      'sha512= with the correct SHA-256 digest',
      `sha512=${hmacHex(BODY, ENV_SECRET)}`,
    ],
    ['a colon instead of =', `sha256:${hmacHex(BODY, ENV_SECRET)}`],
    ['no prefix at all', hmacHex(BODY, ENV_SECRET)],
  ])('%s is rejected', (_name, h) => {
    expect(verify(BODY, h)).toBe(false);
  });

  const good = sign(BODY);
  it.each([
    ['too short', 'sha256=abc123'],
    ['the prefix only', 'sha256='],
    ['odd-length (one digit missing)', good.slice(0, -1)],
    ['odd-length (one digit extra)', `${good}a`],
    ['twice the length', `${good}${good.slice('sha256='.length)}`],
    ['non-hex of the right length', `sha256=${'z'.repeat(64)}`],
    ['non-hex: one digit replaced by g', `${good.slice(0, -1)}g`],
    ['the right length but a different digest', flipLast(good)],
    ['another body’s digest', sign(`${BODY} `)],
  ])('%s is rejected without throwing', (_name, h) => {
    expect(() => verify(BODY, h)).not.toThrow();
    expect(verify(BODY, h)).toBe(false);
  });

  // Recorded, not endorsed: Meta sends lower-case hex and the verifier
  // compares the header text byte for byte, so an upper-case rendering of
  // a CORRECT digest (or an upper-case scheme label) is rejected. That
  // fails closed and is stricter than a hex-decoding comparison would be.
  // If the verifier ever starts decoding hex, change this test on purpose.
  it('current behaviour: an upper-case rendering of a correct digest is rejected', () => {
    const hex = hmacHex(BODY, ENV_SECRET);
    expect(verify(BODY, `sha256=${hex}`)).toBe(true);
    expect(verify(BODY, `sha256=${hex.toUpperCase()}`)).toBe(false);
    expect(verify(BODY, `SHA256=${hex}`)).toBe(false);
  });
});

describe('where the secret comes from', () => {
  it.each([
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
  ])('%s as appSecret falls back to META_APP_SECRET', (_name, appSecret) => {
    expect(verify(BODY, sign(BODY, 'test_app_secret'), appSecret)).toBe(true);
    expect(verify(BODY, sign(BODY, ACCOUNT_SECRET), appSecret)).toBe(false);
  });

  it('an explicit appSecret wins over the environment', () => {
    expect(verify(BODY, sign(BODY, ACCOUNT_SECRET), ACCOUNT_SECRET)).toBe(true);
    expect(verify(BODY, sign(BODY, ENV_SECRET), ACCOUNT_SECRET)).toBe(false);
  });
});

describe('fail closed without a secret', () => {
  it.each([
    ['empty', ''],
    ['unset', undefined],
  ])(
    'rejects a correctly signed request when META_APP_SECRET is %s, and says why',
    (_name, envValue) => {
      vi.stubEnv('META_APP_SECRET', envValue);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Signed with the secret that WOULD have been configured, so the
      // rejection is down to the missing configuration alone.
      expect(verify(BODY, sign(BODY, ENV_SECRET))).toBe(false);
      expect(verify(BODY, sign(BODY, ENV_SECRET), '')).toBe(false);
      expect(verify(BODY, sign(BODY, ENV_SECRET), null)).toBe(false);
      expect(error).toHaveBeenCalledTimes(3);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('no Meta app secret available')
      );
    }
  );

  it('still verifies with an explicit per-account secret, and logs nothing', () => {
    vi.stubEnv('META_APP_SECRET', '');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(verify(BODY, sign(BODY, ACCOUNT_SECRET), ACCOUNT_SECRET)).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('constant-time comparison', () => {
  it('compares equal-length candidates with crypto.timingSafeEqual', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    const good = sign(BODY);

    expect(verify(BODY, good)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(Buffer.from(good), Buffer.from(good));

    // A wrong value of the right length goes through the same compare.
    spy.mockClear();
    expect(verify(BODY, flipLast(good))).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.results[0]).toMatchObject({ type: 'return', value: false });
  });

  it('refuses a header of a different length before comparing (timingSafeEqual would throw)', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    expect(verify(BODY, 'sha256=tooshort')).toBe(false);
    expect(verify(BODY, `${sign(BODY)}00`)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
