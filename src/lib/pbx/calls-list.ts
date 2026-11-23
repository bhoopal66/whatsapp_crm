import type { UnroutedNumber } from '@/lib/pbx/calls';

import { callsListScopes, type CallsTab } from './call-ui';
import { missedWindowStart, type TimelineTask } from './timeline';

/** The most calls, and the most tasks, the Calls screen reads. */
export const CALLS_LIST_LIMIT = 200;

export interface CallsList<C> {
  calls: C[];
  tasks: TimelineTask[];
  /** More missed-call tasks exist than were read. */
  tasksTruncated: boolean;
  /** Unrouted: the dialled numbers, summed over every such call. */
  numbers: UnroutedNumber[];
}

/**
 * What a Calls tab lists, and on Missed calls the callback tasks its
 * badges read. Null for a tab that loads its own.
 *
 * The tasks asked for are the missed-call ones touched inside the calls'
 * own window: read with every other kind of task, 200 older open ones
 * pushed today's callbacks out of the page. Touched, not opened: a repeat
 * call folds into the caller's open task, which can be older than the
 * window (`missedTaskFor`). A failed task read fails the list, because a
 * list without badges says nobody has called back.
 */
export async function loadCallsList<C>(
  tab: CallsTab,
  wide: boolean,
  now: number,
  getJson: (url: string) => Promise<unknown>
): Promise<CallsList<C> | null> {
  const scopes = callsListScopes(tab, wide);
  if (!scopes) return null;
  const since = encodeURIComponent(missedWindowStart(now));
  const from = tab === 'missed' ? `&from=${since}` : '';
  const [c, k] = (await Promise.all([
    getJson(
      `/api/pbx/calls?scope=${scopes.calls}&limit=${CALLS_LIST_LIMIT}${from}`
    ),
    scopes.tasks
      ? getJson(
          `/api/tasks?scope=${scopes.tasks}&status=all&kind=missed_call&updatedSince=${since}&limit=${CALLS_LIST_LIMIT}`
        )
      : {},
  ])) as [
    { calls?: C[]; numbers?: UnroutedNumber[] },
    { tasks?: TimelineTask[]; truncated?: boolean },
  ];
  return {
    calls: c.calls ?? [],
    tasks: k.tasks ?? [],
    tasksTruncated: k.truncated === true,
    numbers: c.numbers ?? [],
  };
}
