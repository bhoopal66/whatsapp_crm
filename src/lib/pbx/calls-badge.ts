import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * What the sidebar's Calls row needs from the database: whether the
 * workspace has a PBX extension, and how many open missed-call tasks
 * are assigned to this person (the rule of `openMissedTasks`).
 *
 * Both are head counts sent together: the tunnel charges ~700 ms a trip
 * and the old path downloaded up to 200 task rows. `tasks_select` RLS
 * confines the count to the active workspace, so there is no account
 * filter. `missed` is null when it could not be counted: the pills show
 * nothing then, the home's tile "–". `tasks.assigned_to` is an auth user id (migration 085).
 *
 * Throws when the extension count fails: "no PBX" would be a guess, and
 * every caller keeps its last answer (or, on a first load, none) rather
 * than hiding the Calls row and card.
 */
export async function loadCallsBadge(
  db: SupabaseClient,
  userId: string
): Promise<{ hasPbx: boolean; missed: number | null }> {
  const [exts, tasks] = await Promise.all([
    db.from('pbx_extensions').select('id', { count: 'exact', head: true }),
    db
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('kind', 'missed_call')
      .eq('status', 'open')
      .eq('assigned_to', userId),
  ]);
  if (exts.error) throw new Error('pbx_extensions count failed');
  const hasPbx = (exts.count ?? 0) > 0;
  return {
    hasPbx,
    missed: !hasPbx ? 0 : tasks.error ? null : (tasks.count ?? 0),
  };
}
