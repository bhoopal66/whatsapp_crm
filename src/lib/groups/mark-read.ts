import { createClient } from '@/lib/supabase/client';

/**
 * A group's read marker (migration 146). The marker lives in
 * `whatsapp_group_reads`, written only by the `whatsapp_group_mark_read`
 * RPC, which moves it forward and refuses a group the caller cannot
 * see. The sidebar's Groups count (`useGroupsUnread`) listens here so
 * opening a group clears it at once instead of on the next poll.
 */

type RpcClient = Pick<ReturnType<typeof createClient>, 'rpc'>;

// One emitter per tab; EventTarget exists in browsers and in node, so
// this needs no `window` and the tests can listen to it too.
const groupReads = new EventTarget();
const GROUP_READ = 'group-read';

/** Calls `listener` with the group id each time a group is marked read. */
export function onGroupRead(listener: (groupId: string) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<string>).detail);
  groupReads.addEventListener(GROUP_READ, handler);
  return () => groupReads.removeEventListener(GROUP_READ, handler);
}

/**
 * Marks a group read for the signed-in person. Best-effort: a refusal or
 * network failure only leaves the group counted, so it resolves `false`
 * rather than throwing into the chat that called it.
 */
export async function markGroupRead(
  groupId: string,
  client: RpcClient = createClient()
): Promise<boolean> {
  try {
    const { error } = await client.rpc('whatsapp_group_mark_read', {
      p_group: groupId,
    });
    if (error) return false;
  } catch {
    return false;
  }
  groupReads.dispatchEvent(new CustomEvent(GROUP_READ, { detail: groupId }));
  return true;
}
