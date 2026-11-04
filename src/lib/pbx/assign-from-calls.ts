import type { SupabaseClient } from '@supabase/supabase-js';

import { contactPhoneCandidates } from './phone';

/**
 * Who may be handed a chat: pbx_extensions_guard's own list (089), so
 * anyone an extension can be mapped to while they are still live here.
 */
const CHAT_HOLDER_ROLES = ['owner', 'admin', 'team_leader', 'agent'];

/**
 * How many of a number's calls are read, newest first. Only a number
 * dialled more often than this has any history left unread, and only a
 * run this long by people who have all left would ever reach it.
 */
const MAX_CALLS = 200;

/**
 * The person who last dialled this number from an extension: the newest
 * outbound call, answered or not, in the whole history of this
 * workspace. A call counts for the person stored on it, then whoever
 * holds its extension now, so a leaver's customers reach their
 * successor. Someone no longer live here is passed over for the next
 * call back. Null when nobody qualifies.
 */
export async function findLastCaller(
  db: SupabaseClient,
  accountId: string,
  phone: string
): Promise<string | null> {
  const numbers = contactPhoneCandidates(phone);
  if (numbers.length === 0) return null;

  const { data: calls, error: callsError } = await db
    .from('calls')
    .select('user_id, extension')
    .eq('account_id', accountId)
    .eq('direction', 'outbound')
    .in('remote_number', numbers)
    .order('started_at', { ascending: false })
    .limit(MAX_CALLS);
  if (callsError) throw new Error(`calls read failed: ${callsError.message}`);
  const rows = (calls ?? []) as {
    user_id: string | null;
    extension: string | null;
  }[];
  if (rows.length === 0) return null;

  const extensions = [
    ...new Set(rows.flatMap((r) => (r.extension ? [r.extension] : []))),
  ];
  const holders = new Map<string, string>();
  if (extensions.length > 0) {
    const { data, error } = await db
      .from('pbx_extensions')
      .select('extension, user_id')
      .eq('account_id', accountId)
      .in('extension', extensions);
    if (error) throw new Error(`extensions read failed: ${error.message}`);
    for (const e of (data ?? []) as {
      extension: string;
      user_id: string | null;
    }[]) {
      if (e.user_id) holders.set(e.extension, e.user_id);
    }
  }

  const candidates = [
    ...new Set(
      rows.flatMap((r) => [
        ...(r.user_id ? [r.user_id] : []),
        ...(r.extension && holders.has(r.extension)
          ? [holders.get(r.extension) as string]
          : []),
      ])
    ),
  ];
  if (candidates.length === 0) return null;

  const { data: profiles, error: profilesError } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .in('user_id', candidates)
    .in('account_role', CHAT_HOLDER_ROLES)
    .is('deactivated_at', null);
  if (profilesError) {
    throw new Error(`profiles read failed: ${profilesError.message}`);
  }
  const live = new Set(
    ((profiles ?? []) as { user_id: string }[]).map((p) => p.user_id)
  );
  return candidates.find((id) => live.has(id)) ?? null;
}

/**
 * Hand a chat nobody holds to the person who last called its customer.
 * The on_conversation_assigned trigger rings their bell and 169 moves
 * the contact to them, as for any assignment.
 *
 * The write is conditional, so an assignment made since the caller read
 * the chat stands. Never throws: this runs on the inbound path, and a
 * chat that stays unassigned is better than a lost message. Returns the
 * person the chat went to, or null.
 */
export async function assignChatFromCallHistory(
  db: SupabaseClient,
  chat: { accountId: string; conversationId: string; phone: string }
): Promise<string | null> {
  try {
    const userId = await findLastCaller(db, chat.accountId, chat.phone);
    if (!userId) return null;
    const { data, error } = await db
      .from('conversations')
      .update({ assigned_agent_id: userId })
      .eq('id', chat.conversationId)
      .eq('account_id', chat.accountId)
      .is('assigned_agent_id', null)
      .select('id');
    if (error) throw new Error(`conversation update failed: ${error.message}`);
    return (data ?? []).length > 0 ? userId : null;
  } catch (err) {
    console.error(
      '[inbound] assigning from call history failed:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
