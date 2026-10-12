import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyYeastarWebhookSignature as verify } from '../webhook';

// The docs' example 32-character webhook secret.
const SECRET = 'Pugghh14VCb05rtG7WGumbD4hwJPIvzu';
const BODY =
  '{"type":30012,"sn":"3631A2124XXX","msg":{"call_id":"1780625997.105","uid":"202606051019574F506"}}';
const sign = (body: string, secret = SECRET) =>
  crypto.createHmac('sha256', secret).update(body).digest('base64');

describe('verifyYeastarWebhookSignature', () => {
  it('accepts Base64(HMAC-SHA256(raw body, secret))', () => {
    expect(verify(BODY, sign(BODY), SECRET)).toBe(true);
    expect(verify(BODY, ` ${sign(BODY)} `, SECRET)).toBe(true);
    expect(
      verify(
        '{"event":"test","message":"This is a webhook connectivity test."}',
        sign(
          '{"event":"test","message":"This is a webhook connectivity test."}'
        ),
        SECRET
      )
    ).toBe(true);
  });

  it('rejects a tampered body, a tampered signature, another secret', () => {
    expect(
      verify(
        BODY.replace('1002', '1003').replace('30012', '30011'),
        sign(BODY),
        SECRET
      )
    ).toBe(false);
    expect(verify(` ${BODY}`, sign(BODY), SECRET)).toBe(false);
    const sig = sign(BODY);
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(verify(BODY, flipped, SECRET)).toBe(false);
    expect(verify(BODY, sign(BODY, 'x'.repeat(32)), SECRET)).toBe(false);
    expect(
      verify(
        BODY,
        crypto.createHmac('sha256', SECRET).update(BODY).digest('hex'),
        SECRET
      )
    ).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    const short = crypto.randomBytes(31).toString('base64');
    const long = crypto.randomBytes(33).toString('base64');
    for (const header of [
      short,
      long,
      sign(BODY).slice(0, -2),
      `${sign(BODY)}AAAA`,
    ]) {
      expect(() => verify(BODY, header, SECRET)).not.toThrow();
      expect(verify(BODY, header, SECRET)).toBe(false);
    }
  });

  it('rejects a missing or malformed header and an empty secret', () => {
    for (const header of [
      null,
      undefined,
      '',
      'not base64 at all!',
      `sha256=${sign(BODY)}`,
    ]) {
      expect(verify(BODY, header, SECRET)).toBe(false);
    }
    expect(verify(BODY, sign(BODY, ''), '')).toBe(false);
  });
});
