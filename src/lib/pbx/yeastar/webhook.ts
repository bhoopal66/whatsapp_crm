import crypto from 'node:crypto';

/** SHA-256 output in bytes; Base64 of it is 44 characters. */
const DIGEST_BYTES = 32;
const BASE64_DIGEST = /^[A-Za-z0-9+/]{43}=?$/;

/**
 * Verify a Yeastar webhook's `X-Signature` header (firmware 84.20.0.21+):
 * Base64(HMAC-SHA256(raw body, the webhook's 32-character Secret)).
 *
 * `rawBody` must be the body exactly as received: re-serialised JSON
 * signs differently. Fails closed: a missing header, an empty secret, a
 * header that is not the Base64 of 32 bytes, or a mismatch is false.
 * Never throws, and compares in constant time.
 */
export function verifyYeastarWebhookSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string
): boolean {
  if (!secret || typeof header !== 'string' || typeof rawBody !== 'string')
    return false;
  const sent = header.trim();
  if (!BASE64_DIGEST.test(sent)) return false;
  const given = Buffer.from(sent, 'base64');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest();
  // timingSafeEqual throws on unequal lengths.
  if (given.length !== DIGEST_BYTES || given.length !== expected.length)
    return false;
  return crypto.timingSafeEqual(given, expected);
}
