/**
 * Admin API guard: lockout → rate limit (ip, user) → failure/success
 * bookkeeping. Admin rate-limit scopes fail closed; a lockout-store error
 * propagates (host → 500). `now` is for tests: omitted, the memory stores
 * use Date.now() and the RPC stores the database clock.
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
  // The stores compare user keys exactly; "A" and "a" are one user.
  const userId = req.userId?.toLowerCase();
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
  if (!req.authOk) {
    await ctx.lockout.recordFailure(req.ip, now, userId);
    return { allowed: false, status: 401 };
  }
  await ctx.lockout.recordSuccess(req.ip, userId);
  return { allowed: true, status: 200 };
}
