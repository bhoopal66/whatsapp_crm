import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Record that the customer asked not to be messaged, when the TypeSafe
 * triage check (063) acts on a free-text request to stop: stamps
 * `contacts.opted_out_at` (migration 076). Every broadcast skips a
 * stamped contact, when it is planned and again when it is sent.
 * docs/typesafe.md says what it does not do.
 *
 * Returns true only when this call newly marked the contact; an earlier
 * stamp is kept, so the time records when they first asked.
 * Best-effort by contract: returns false and logs on any failure — the
 * hand-off that follows must happen whether or not the stamp lands.
 */
export async function markOptedOut(
  db: SupabaseClient,
  args: { accountId: string; contactId: string }
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('contacts')
      .update({ opted_out_at: new Date().toISOString() })
      .eq('id', args.contactId)
      .eq('account_id', args.accountId)
      .is('opted_out_at', null)
      .select('id');
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
  } catch (err) {
    console.error('[ai auto-reply] marking the contact opted-out failed:', err);
    return false;
  }
}
