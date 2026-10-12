/**
 * Admin API guard: lockout → rate limit (ip, user) → failure/success
 * bookkeeping. Admin rate-limit scopes fail closed; a lockout-store error
 * propagates (host → 500). `now` is for tests: omitted, the memory stores
 * use Date.now() and the RPC stores the database clock.
 *
 * `guardAdmin` takes a credential already checked. When the check itself
 * must be gated — a password sent on to GoTrue — run the two halves
 * around it: `admitAdmin` before, `settleAdmin` after, so a locked or
 * rate-limited caller never reaches the check.
 */
import { ipKey } from './ip';
import type { AuthLockout } from './lockout';
import type { RateLimiter } from './ratelimit';

export type AdminCtx = { lockout: AuthLockout; limiter: RateLimiter };
export type AdminReq = { ip: string; userId?: string; authOk: boolean };
export type AdminDecision = {
  allowed: boolean;
  status: 200 | 401 | 423 | 429;
  retryAfterMs?: number;
};

export async function guardAdmin(
  ctx: AdminCtx,
  req: AdminReq,
  now?: number
): Promise<AdminDecision> {
  return (await admitAdmin(ctx, req, now)) ?? settleAdmin(ctx, req, now);
}

/** The checks before the credential: a refusal (423 / 429), or null to go on. Records nothing. */
export async function admitAdmin(
  ctx: AdminCtx,
  req: Pick<AdminReq, 'ip' | 'userId'>,
  now?: number
): Promise<AdminDecision | null> {
  const userId = userKey(req.userId);
  const lock = await ctx.lockout.state(req.ip, now, userId);
  if (lock.locked) {
    return { allowed: false, status: 423, retryAfterMs: lock.retryAfterMs };
  }
  const byIp = await ctx.limiter.check('admin.ip', ipKey(req.ip), now);
  if (!byIp.allowed) {
    return { allowed: false, status: 429, retryAfterMs: byIp.retryAfterMs };
  }
  if (userId) {
    const byUser = await ctx.limiter.check('admin.user', userId, now);
    if (!byUser.allowed) {
      return { allowed: false, status: 429, retryAfterMs: byUser.retryAfterMs };
    }
  }
  return null;
}

/** The bookkeeping after it: a failure → 401 (counted), a success clears the pair → 200. */
export async function settleAdmin(
  ctx: AdminCtx,
  req: AdminReq,
  now?: number
): Promise<AdminDecision> {
  const userId = userKey(req.userId);
  if (!req.authOk) {
    await ctx.lockout.recordFailure(req.ip, now, userId);
    return { allowed: false, status: 401 };
  }
  await ctx.lockout.recordSuccess(req.ip, userId);
  return { allowed: true, status: 200 };
}

// The stores compare user keys exactly; "A" and "a" are one user.
const userKey = (userId: string | undefined) => userId?.toLowerCase();
