/**
 * The bearer token that guards GET /api/metrics (package 033f).
 *
 * METRICS_TOKEN must be at least 32 characters; unset or shorter means the
 * page is off (501), logged once without the value. The comparison is
 * timing-safe. Wrong tokens do not feed the sign-in lockout: the length
 * makes guessing hopeless.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const METRICS_TOKEN_MIN = 32;

let warned = false;

export function metricsToken(
  env: Record<string, string | undefined> = process.env
): string | null {
  const v = env.METRICS_TOKEN?.trim();
  if (!v) return null;
  if (v.length < METRICS_TOKEN_MIN) {
    if (!warned) {
      warned = true;
      console.error(
        `[metrics] off: METRICS_TOKEN must be at least ${METRICS_TOKEN_MIN} characters`
      );
    }
    return null;
  }
  return v;
}

/** `Authorization: Bearer <token>`, compared without leaking timing. */
export function bearerMatches(header: string | null, token: string): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  // Hash both sides so the comparison is fixed-length whatever was sent.
  const a = createHash('sha256').update(m[1]).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}
