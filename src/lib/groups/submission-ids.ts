import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Of these WhatsApp ids, the ones that are submission groups; with
 * `channelId`, only those of that number, whose messages the submission
 * module records itself (`findByWaGroupId` asks for the number too).
 */
export async function submissionGroupIds(
  admin: SupabaseClient,
  accountId: string,
  waGroupIds: string[],
  channelId?: string
): Promise<Set<string>> {
  if (waGroupIds.length === 0) return new Set();
  let query = admin
    .from('submission_groups')
    .select('wa_group_id')
    .eq('account_id', accountId)
    .in('wa_group_id', waGroupIds);
  if (channelId) query = query.eq('channel_id', channelId);
  const { data, error } = await query;
  if (error) throw error;
  return new Set(
    ((data ?? []) as Array<{ wa_group_id: string }>).map((r) => r.wa_group_id)
  );
}
