/**
 * The one way the Rpc*Store classes reach migration 084: supabase-js
 * `rpc()` with named arguments on a service-role client. An RPC error (or
 * a malformed answer) is thrown, so each caller's failure policy decides:
 * webhook rate scopes fail open, admin scopes fail closed, lockout
 * propagates.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type RpcClockOptions = {
  /** Send the caller's time as `p_now` (tests replaying fixed times). Off: the database clock. */
  useCallerClock?: boolean;
};

export async function callEdgeRpc(
  client: SupabaseClient,
  fn: string,
  args: Record<string, string | number | boolean>
): Promise<unknown> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return data;
}

/** A RETURNS TABLE function answers a one-row array. */
export function firstRow(fn: string, data: unknown): Record<string, unknown> {
  const row: unknown = Array.isArray(data) ? data[0] : data;
  if (typeof row !== 'object' || row === null) {
    throw new Error(`${fn} returned no row`);
  }
  return row as Record<string, unknown>;
}

/** `{ p_now }` only when the store uses the caller's clock and a time was given. */
export function callerNow(
  useCallerClock: boolean | undefined,
  now: number | undefined
): { p_now?: string } {
  return useCallerClock && now !== undefined
    ? { p_now: new Date(now).toISOString() }
    : {};
}
