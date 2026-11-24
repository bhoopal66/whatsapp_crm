import type { SupabaseClient } from '@supabase/supabase-js';

/** Of these WhatsApp ids, the ones that are submission groups. */
export async function submissionGroupIds(
  admin: SupabaseClient,
  accountId: string,
  waGroupIds: string[]
): Promise<Set<string>> {
  if (waGroupIds.length === 0) return new Set();
  const { data, error } = await admin
    .from('submission_groups')
    .select('wa_group_id')
    .eq('account_id', accountId)
    .in('wa_group_id', waGroupIds);
  if (error) throw error;
  return new Set(
    ((data ?? []) as Array<{ wa_group_id: string }>).map((r) => r.wa_group_id)
  );
}
