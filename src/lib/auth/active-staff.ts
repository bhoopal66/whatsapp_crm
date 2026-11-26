import type { SupabaseClient } from '@supabase/supabase-js';
import { STAFF_ROLES, type AccountRole } from '@/lib/auth/roles';

/**
 * Whether a person can hold a chat of this account: staff, not
 * deactivated. `error` when that could not be read. For service-role
 * callers that assign from stored configuration.
 */
export async function isActiveStaff(
  db: SupabaseClient,
  accountId: string,
  userId: string
): Promise<{ ok: boolean; error: string | null }> {
  const { data, error } = await db
    .from('profiles')
    .select('account_role')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .is('deactivated_at', null)
    .limit(1);
  if (error) return { ok: false, error: error.message };
  const role = (data as { account_role: AccountRole }[] | null)?.[0]
    ?.account_role;
  return {
    ok: !!role && (STAFF_ROLES as readonly AccountRole[]).includes(role),
    error: null,
  };
}
