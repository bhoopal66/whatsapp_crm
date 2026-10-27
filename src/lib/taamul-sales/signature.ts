import crypto from 'node:crypto';

/** How far X-Taamul-Timestamp may be from our clock, either way. */
export const MAX_CLOCK_SKEW_SECONDS = 300;

const SIGNATURE = /^sha256=([0-9a-fA-F]{64})$/;
const TIMESTAMP = /^\d{1,12}$/;

export type SignatureVerdict =
  { ok: true } | { ok: false; reason: 'malformed' | 'stale' | 'mismatch' };

/**
 * Verify a Taamul sales-app webhook: `X-Taamul-Signature` is
 * `sha256=<hex HMAC-SHA256(secret, "<X-Taamul-Timestamp>.<raw body>")>`.
 *
 * `rawBody` must be the bytes exactly as received: re-serialised JSON
 * signs differently. A timestamp more than five minutes from `nowMs`
 * is refused even with a good signature, so a captured delivery cannot
 * be replayed later. Fails closed: a missing or malformed header or an
 * empty secret is a refusal. Never throws; compares in constant time.
 */
export function verifyTaamulSignature(input: {
  rawBody: Uint8Array;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  secret: string;
  nowMs?: number;
}): SignatureVerdict {
  const { rawBody, secret } = input;
  const timestamp = input.timestamp?.trim() ?? '';
  const match = SIGNATURE.exec(input.signature?.trim() ?? '');
  if (!secret || !match || !TIMESTAMP.test(timestamp)) {
    return { ok: false, reason: 'malformed' };
  }

  const nowSeconds = (input.nowMs ?? Date.now()) / 1000;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'stale' };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.`, 'utf8')
    .update(rawBody)
    .digest();
  const given = Buffer.from(match[1], 'hex');
  // timingSafeEqual throws on unequal lengths; the pattern pins 32 bytes.
  if (given.length !== expected.length)
    return { ok: false, reason: 'mismatch' };
  return crypto.timingSafeEqual(given, expected)
    ? { ok: true }
    : { ok: false, reason: 'mismatch' };
}
