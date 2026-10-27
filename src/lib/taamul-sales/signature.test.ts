import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { verifyTaamulSignature } from './signature';

const SECRET = 'whsec_test_secret';
const NOW = 1_793_000_000_000;
const TS = String(NOW / 1000);
const BODY = '{"event_id":"e1","event_type":"contact.interested"}';
const bytes = (s: string) => new TextEncoder().encode(s);
const sign = (body: string, ts = TS, secret = SECRET) =>
  'sha256=' +
  crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

const verify = (o: {
  body?: string;
  ts?: string | null;
  sig?: string | null;
  secret?: string;
}) =>
  verifyTaamulSignature({
    rawBody: bytes(o.body ?? BODY),
    timestamp: o.ts === undefined ? TS : o.ts,
    signature: o.sig === undefined ? sign(BODY) : o.sig,
    secret: o.secret ?? SECRET,
    nowMs: NOW,
  });

describe('verifyTaamulSignature', () => {
  it('accepts the HMAC of "<timestamp>.<raw body>"', () => {
    expect(verify({})).toEqual({ ok: true });
    expect(
      verify({ sig: sign(BODY).toUpperCase().replace('SHA256=', 'sha256=') })
    ).toEqual({ ok: true });
  });

  it('refuses a body changed after signing, even only re-serialised', () => {
    expect(verify({ body: BODY.replace(':', ': ') })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('refuses another secret, or the timestamp left out of the HMAC', () => {
    expect(verify({ sig: sign(BODY, TS, 'other') }).ok).toBe(false);
    const bodyOnly =
      'sha256=' +
      crypto.createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verify({ sig: bodyOnly }).ok).toBe(false);
  });

  it('refuses a timestamp more than five minutes away, either way', () => {
    for (const offset of [301, -301]) {
      const ts = String(NOW / 1000 + offset);
      expect(verify({ ts, sig: sign(BODY, ts) })).toEqual({
        ok: false,
        reason: 'stale',
      });
    }
    const edge = String(NOW / 1000 - 300);
    expect(verify({ ts: edge, sig: sign(BODY, edge) })).toEqual({ ok: true });
  });

  it('fails closed on missing or malformed headers and an empty secret', () => {
    expect(verify({ sig: null }).ok).toBe(false);
    expect(verify({ ts: null }).ok).toBe(false);
    expect(verify({ ts: '17.5' }).ok).toBe(false);
    expect(verify({ sig: sign(BODY).slice('sha256='.length) }).ok).toBe(false);
    expect(verify({ sig: 'sha256=abc' }).ok).toBe(false);
    expect(verify({ secret: '' }).ok).toBe(false);
  });
});
