// ============================================================
// The process-wide sign-in guards (module 017a): the admin lockout and
// the admin rate limits, used by POST /api/auth/login and, for the
// lockout alone, by the public API's key check.
//
// They keep nothing in memory — failures, locks and rate windows live
// in migration 084's tables, shared by every app instance — so one pair
// per process serves every request. Lazy, so `next build` never needs
// the service-role key. Tests mock this module with memory stores.
// ============================================================

import {
  AuthLockout,
  RateLimiter,
  RpcLockoutStore,
  RpcRateStore,
  type AdminCtx,
} from '@/lib/edge';
import { supabaseAdmin } from '@/lib/flows/admin-client';

let guards: AdminCtx | null = null;

export function edgeAuthGuards(): AdminCtx {
  if (!guards) {
    const admin = supabaseAdmin();
    guards = {
      lockout: new AuthLockout(new RpcLockoutStore(admin)),
      limiter: new RateLimiter(new RpcRateStore(admin)),
    };
  }
  return guards;
}
