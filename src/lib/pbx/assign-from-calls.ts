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
 * The person who last dialled this customer from an extension: the
 * newest outbound call, answered or not, in the whole history of this
 * workspace, to the number or already linked to the contact (the PBX
 * links on a looser match than the exact forms tried here). A call
 * counts for the person stored on it, then whoever holds its extension
 * now, so a leaver's customers reach their successor. Someone no longer
 * live here is passed over for the next call back. Null when nobody
 * qualifies.
 */
export async function findLastCaller(
  db: SupabaseClient,
  accountId: string,
  customer: { phone: string; contactId: string }
): Promise<string | null> {
  const numbers = contactPhoneCandidates(customer.phone);
  const byNumber = numbers.length
    ? `remote_number.in.(${numbers.join(',')}),`
    : '';

  const { data: calls, error: callsError } = await db
    .from('calls')
    .select('user_id, extension, connection_id')
    .eq('account_id', accountId)
    .eq('direction', 'outbound')
    .or(`${byNumber}contact_id.eq.${customer.contactId}`)
    .order('started_at', { ascending: false })
    .limit(MAX_CALLS);
  if (callsError) throw new Error(`calls read failed: ${callsError.message}`);
  const rows = (calls ?? []) as {
    user_id: string | null;
    extension: string | null;
    connection_id: string | null;
  }[];
  if (rows.length === 0) return null;

  const extensions = [
    ...new Set(rows.flatMap((r) => (r.extension ? [r.extension] : []))),
  ];
  // An extension number is unique per PBX, not per workspace.
  const holderKey = (connectionId: string | null, extension: string) =>
    `${connectionId}:${extension}`;
  const holders = new Map<string, string>();
  if (extensions.length > 0) {
    const { data, error } = await db
      .from('pbx_extensions')
      .select('connection_id, extension, user_id')
      .eq('account_id', accountId)
      .in('extension', extensions);
    if (error) throw new Error(`extensions read failed: ${error.message}`);
    for (const e of (data ?? []) as {
      connection_id: string;
      extension: string;
      user_id: string | null;
    }[]) {
      if (e.user_id) {
        holders.set(holderKey(e.connection_id, e.extension), e.user_id);
      }
    }
  }

  const candidates = [
    ...new Set(
      rows.flatMap((r) => {
        const holder = r.extension
          ? holders.get(holderKey(r.connection_id, r.extension))
          : undefined;
        return [r.user_id, holder].filter((id): id is string => Boolean(id));
      })
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
 * A contact owned by a live agent or team leader is already someone's
 * customer, chat or no chat. An owner or admin does not count: every
 * inbound contact starts out theirs (the person who connected the
 * number), and that default is what the caller replaces.
 */
async function ownedByAgent(
  db: SupabaseClient,
  accountId: string,
  ownerId: string
): Promise<boolean> {
  const { data, error } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .eq('user_id', ownerId)
    .in('account_role', ['team_leader', 'agent'])
    .is('deactivated_at', null)
    .maybeSingle();
  if (error) throw new Error(`profile read failed: ${error.message}`);
  return Boolean(data);
}

/**
 * Hand a chat nobody holds to the person who last called its customer.
 * The on_conversation_assigned trigger rings their bell and 169 moves
 * the contact to them, as for any assignment, which is why a contact
 * another agent owns is left alone: it would be taken from them.
 *
 * The write is conditional, so an assignment made since the caller read
 * the chat stands. Never throws: this runs on the inbound path, and a
 * chat that stays unassigned is better than a lost message. Returns the
 * person the chat went to, or null.
 */
export async function assignChatFromCallHistory(
  db: SupabaseClient,
  chat: {
    accountId: string;
    conversationId: string;
    contactId: string;
    contactOwnerId: string | null;
    phone: string;
  }
): Promise<string | null> {
  try {
    const userId = await findLastCaller(db, chat.accountId, chat);
    if (!userId) return null;
    if (
      chat.contactOwnerId &&
      chat.contactOwnerId !== userId &&
      (await ownedByAgent(db, chat.accountId, chat.contactOwnerId))
    ) {
      return null;
    }
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
