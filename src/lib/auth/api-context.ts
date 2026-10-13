// ============================================================
// Public API authentication — resolve a request's API key into an
// account context.
//
// This is the machine-to-machine counterpart of `getCurrentAccount`
// (cookie session → account). Where the dashboard authenticates a
// human via Supabase cookies, the public API authenticates a caller
// via `Authorization: Bearer taamul_live_…`.
//
// Calling convention — every `/api/v1` route does:
//
//   try {
//     const ctx = await requireApiKey(request, "messages:send");
//     // ctx.supabase   — service-role client (no user session exists)
//     // ctx.accountId  — the key's account; scope every query by it
//     // ctx.scopes     — granted scopes
//     // ctx.keyId      — for logging / the rate-limit bucket
//   } catch (err) {
//     return toApiErrorResponse(err);   // maps ApiError → envelope
//   }
//
// Why a service-role client: an API caller has no Supabase session,
// so there's no `auth.uid()` for RLS to match. The key lookup itself
// establishes the account; from there every downstream query MUST be
// explicitly filtered by `ctx.accountId` (the same discipline the
// dashboard's send route already follows). The key never escalates
// past its own account because the account is fixed at lookup time.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { lookupKeyByHash, touchLastUsed } from '@/lib/api-keys/store';
import { hashApiKey, looksLikeApiKey } from '@/lib/api-keys/keys';
import { hasScope, type ApiScope } from '@/lib/api-keys/scopes';
import { forbidden, rateLimited, unauthorized } from '@/lib/api/v1/respond';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { edgeAuthGuards } from '@/lib/auth/edge-guards';
import { clientIp, consoleLogger, ipKey } from '@/lib/edge';

export interface ApiKeyContext {
  /** Discriminant — lets shared logic tell key auth from cookie auth. */
  authType: 'api_key';
  /** Service-role Supabase client. RLS-bypassing; scope by accountId. */
  supabase: SupabaseClient;
  /** The account this key belongs to. */
  accountId: string;
  /** The key row id — for audit logging and the rate-limit bucket. */
  keyId: string;
  /** Scopes granted to this key. */
  scopes: string[];
  /** Who minted the key (null if that user was later removed). */
  createdBy: string | null;
}

/**
 * Extract the bearer token from the `Authorization` header.
 * Tolerates the `Bearer ` prefix being absent (some clients send the
 * bare key) but requires the value to look like one of our keys.
 */
function extractKey(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const value = header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : header.trim();
  return value.length > 0 ? value : null;
}

/**
 * Authenticate a public-API request and (optionally) enforce a
 * single scope. Throws an `ApiError` (mapped to the envelope by
 * `toApiErrorResponse`) on any failure:
 *
 *   401 unauthorized — no key, malformed, unknown, revoked, expired,
 *                      or its workspace archived (migration 105)
 *   403 forbidden    — valid key without the required scope
 *   429 rate_limited — per-key budget exhausted, or this client IP is
 *                      locked out for presenting bad keys
 *
 * On success, bumps `last_used_at` (fire-and-forget) and returns the
 * account context.
 */
export async function requireApiKey(
  request: Request,
  scope?: ApiScope
): Promise<ApiKeyContext> {
  const presented = extractKey(request);
  if (!presented || !looksLikeApiKey(presented)) {
    throw unauthorized();
  }

  // Bad-key lockout (module 017a), keyed `apikey:<client ip>` with no
  // user, so 5 bad keys in a row or 20 in 10 minutes lock the IP for
  // 15. A locked caller is refused before its key is looked up, with
  // the ordinary rate-limit answer: lockout and rate limiting look the
  // same on the wire. Without a client IP (EDGE_CLIENT_IP_HEADER unset)
  // there is nothing to key on — one shared bucket would let one bad
  // caller lock out every integration — so the lockout is skipped.
  const ip = clientIp(request.headers);
  const lockKey = ip ? `apikey:${ipKey(ip)}` : null;
  if (lockKey) await refuseLockedCaller(lockKey);

  const {
    key: row,
    archived,
    archivedKeyId,
  } = await lookupKeyByHash(hashApiKey(presented));
  if (!row) {
    // Covers unknown, revoked, and expired keys alike — we don't
    // distinguish them on the wire so a probe can't learn whether a
    // key ever existed. A live key of an archived workspace (105) is
    // refused the same way but is not a bad key: an integration that
    // serves several workspaces from one IP (Compass) would otherwise
    // lock itself out of the live ones by retrying it. It keeps its
    // per-key rate limit instead, so holding one buys no free requests.
    if (archived && archivedKeyId) {
      const limit = checkRateLimit(
        `apikey:${archivedKeyId}`,
        RATE_LIMITS.publicApi
      );
      if (!limit.success) throw rateLimited(limit);
    } else if (lockKey) await recordKey(lockKey, false);
    throw unauthorized();
  }

  // Rate-limit per key, before the scope check, so an unauthorized-
  // scope caller still can't hammer the endpoint for free.
  const limit = checkRateLimit(`apikey:${row.id}`, RATE_LIMITS.publicApi);
  if (!limit.success) {
    throw rateLimited(limit);
  }

  if (lockKey) await recordKey(lockKey, true);

  if (scope && !hasScope(row.scopes, scope)) {
    throw forbidden(`This API key is missing the '${scope}' scope`);
  }

  touchLastUsed(row.id);

  return {
    authType: 'api_key',
    supabase: supabaseAdmin(),
    accountId: row.account_id,
    keyId: row.id,
    scopes: row.scopes,
    createdBy: row.created_by,
  };
}

// The lockout fails OPEN here, unlike sign-in. API keys are 256-bit
// random secrets, so the lockout is defence in depth, not the barrier a
// password needs; and Compass, the MCP server and every other
// integration live on this API. An unreachable edge store must not take
// all of them down, so a store error is logged and the request goes on.

async function refuseLockedCaller(lockKey: string): Promise<void> {
  let retryAfterMs = 0;
  try {
    const lock = await edgeAuthGuards().lockout.state(lockKey);
    if (lock.locked) retryAfterMs = lock.retryAfterMs;
  } catch (err) {
    consoleLogger.warn('api-key lockout unreadable; failing open', {
      err: String(err),
    });
  }
  if (retryAfterMs > 0) {
    throw rateLimited({
      success: false,
      remaining: 0,
      reset: Date.now() + retryAfterMs,
      limit: RATE_LIMITS.publicApi.limit,
    });
  }
}

async function recordKey(lockKey: string, good: boolean): Promise<void> {
  try {
    const { lockout } = edgeAuthGuards();
    if (good) await lockout.recordSuccess(lockKey);
    else await lockout.recordFailure(lockKey);
  } catch (err) {
    consoleLogger.warn('api-key lockout not recorded; failing open', {
      err: String(err),
    });
  }
}
