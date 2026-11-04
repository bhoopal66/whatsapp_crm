import { createClient } from '@/lib/supabase/client';

/**
 * A submission group's read marker (migration 173). The marker is per
 * person, written only by the `sg_mark_read` RPC, which moves it forward
 * and refuses a group the caller cannot see. The sidebar count
 * (`useSubmissionGroupsUnread`) listens here so opening a group clears
 * it at once instead of on the next poll.
 */

type RpcClient = Pick<ReturnType<typeof createClient>, 'rpc'>;

// One emitter per tab; EventTarget exists in browsers and in node, so
// this needs no `window` and the tests can listen to it too.
const submissionGroupReads = new EventTarget();
const SUBMISSION_GROUP_READ = 'submission-group-read';

/** Calls `listener` with the group id each time a group is marked read. */
export function onSubmissionGroupRead(
  listener: (groupId: string) => void
): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<string>).detail);
  submissionGroupReads.addEventListener(SUBMISSION_GROUP_READ, handler);
  return () =>
    submissionGroupReads.removeEventListener(SUBMISSION_GROUP_READ, handler);
}

/**
 * Marks a group read for the signed-in person. Best-effort: a refusal or
 * network failure only leaves the group counted, so it resolves `false`
 * rather than throwing into the chat that called it.
 */
export async function markSubmissionGroupRead(
  groupId: string,
  client: RpcClient = createClient()
): Promise<boolean> {
  try {
    const { error } = await client.rpc('sg_mark_read', {
      p_group: groupId,
    });
    if (error) return false;
  } catch {
    return false;
  }
  submissionGroupReads.dispatchEvent(
    new CustomEvent(SUBMISSION_GROUP_READ, { detail: groupId })
  );
  return true;
}
