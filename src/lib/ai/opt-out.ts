import type { SupabaseClient } from '@supabase/supabase-js';
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write';

/**
 * The tag a contact gets when the TypeSafe triage check (063) acts on a
 * free-text request to stop messages. The app has no consent register:
 * the tag is what admins exclude from broadcast audiences, and what a
 * person sees before resuming the bot on the thread. docs/typesafe.md
 * says what it does not do.
 */
export const OPT_OUT_TAG = 'opted-out';
const OPT_OUT_COLOR = '#ef4444';

/**
 * Tag the contact `opted-out`, creating the account's tag on first use.
 * Best-effort by contract: returns false and logs on any failure — the
 * hand-off that follows must happen whether or not the tag lands. Does
 * not fire `tag_added` automations: nothing should start messaging a
 * contact because they asked us to stop.
 */
export async function tagOptedOut(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; userId: string }
): Promise<boolean> {
  // The account's tag is its OLDEST `opted-out` row: tags has no unique
  // name, so two first-ever opt-outs racing can each create one.
  const oldestTag = async (): Promise<string | null> => {
    const { data, error } = await db
      .from('tags')
      .select('id')
      .eq('account_id', args.accountId)
      .ilike('name', OPT_OUT_TAG)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as { id: string } | null)?.id ?? null;
  };
  try {
    let tagId = await oldestTag();
    if (!tagId) {
      const { data: created, error: createErr } = await db
        .from('tags')
        .insert({
          account_id: args.accountId,
          user_id: args.userId,
          name: OPT_OUT_TAG,
          color: OPT_OUT_COLOR,
        })
        .select('id')
        .single();
      if (createErr) throw createErr;
      const mine = (created as { id: string }).id;
      // Lost a race to a concurrent opt-out: converge on the oldest tag,
      // so one exclusion in a broadcast audience covers every contact.
      tagId = (await oldestTag()) ?? mine;
      if (tagId !== mine) await db.from('tags').delete().eq('id', mine);
    }
    await addContactTagIfAbsent(db, {
      accountId: args.accountId,
      contactId: args.contactId,
      tagId,
    });
    return true;
  } catch (err) {
    console.error('[ai auto-reply] opt-out tag failed:', err);
    return false;
  }
}
