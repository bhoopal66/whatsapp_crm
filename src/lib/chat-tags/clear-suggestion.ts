import { supabaseAdmin } from '@/lib/ai/admin-client';

/**
 * Clears a stored tag suggestion and stamps suggestion_basis_at with now:
 * a Jev judgment of an older message still in flight then finds its basis
 * outdated and cannot store a suggestion over the person's choice. Always
 * written (not only when a suggestion is stored) for that reason. Logs and
 * carries on on failure. Shared by the single-chat and the bulk tag routes
 * (the columns are service-role only, migration 147).
 */
export async function clearTagSuggestion(
  accountId: string,
  conversationId: string
): Promise<void> {
  try {
    const { error } = await supabaseAdmin()
      .from('conversations')
      .update({
        suggested_chat_tag_id: null,
        suggested_chat_sub_tag_id: null,
        suggested_tag_p: null,
        suggested_tag_at: null,
        suggestion_basis_at: new Date().toISOString(),
      })
      .eq('id', conversationId)
      .eq('account_id', accountId);
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error(
      '[chat-tags] clearing the tag suggestion failed:',
      err instanceof Error ? err.message : String(err)
    );
  }
}
