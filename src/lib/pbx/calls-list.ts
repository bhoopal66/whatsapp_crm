import type { UnroutedNumber } from '@/lib/pbx/calls';

import { callsListScope, type CallsTab } from './call-ui';
import { missedWindowStart } from './timeline';

/** The most calls the Calls screen reads at once. */
export const CALLS_LIST_LIMIT = 200;

export interface CallsList<C> {
  calls: C[];
  /** Unrouted: the dialled numbers, summed over every such call. */
  numbers: UnroutedNumber[];
}

/**
 * What a Calls tab lists. Null for a tab that loads its own. A missed
 * call comes with its callback task (lib/pbx/missed-tasks.ts).
 */
export async function loadCallsList<C>(
  tab: CallsTab,
  wide: boolean,
  now: number,
  getJson: (url: string) => Promise<unknown>
): Promise<CallsList<C> | null> {
  const scope = callsListScope(tab, wide);
  if (!scope) return null;
  const q = new URLSearchParams({ scope, limit: String(CALLS_LIST_LIMIT) });
  if (tab === 'missed') q.set('from', missedWindowStart(now));
  const body = (await getJson(`/api/pbx/calls?${q}`)) as {
    calls?: C[];
    numbers?: UnroutedNumber[];
  };
  return { calls: body.calls ?? [], numbers: body.numbers ?? [] };
}
