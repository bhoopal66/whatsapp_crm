'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { useCalls } from '@/components/pbx/call-provider';
import { liveKey, type CallSides, type CallsTab } from '@/lib/pbx/call-ui';
import {
  callLeft,
  listReducer,
  loadCallsList,
  startCallsRefresh,
  type ListAction,
  type ListView,
} from '@/lib/pbx/calls-list';
import type { MissedCallTask } from '@/lib/pbx/missed-tasks';
import type { TimelineCall } from '@/lib/pbx/timeline';

export type CallRow = TimelineCall & {
  contactId: string | null;
  contactName: string | null;
  remoteNumber: string | null;
  doNotContactAt: string | null;
  doNotContactReason: string | null;
  /** The number the customer dialled (calls.did_number). */
  didNumber?: string | null;
  /** Internal calls only: both extensions and their people. */
  party?: CallSides;
  /** Missed calls only: the callback task, whoever holds it. */
  task?: MissedCallTask | null;
};
const getJson = (url: string) =>
  fetch(url, { cache: 'no-store' }).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  });

/**
 * The Calls screen's list: one read per tab and reach, refreshed while
 * the screen is open and when one of the caller's calls ends, and the
 * older pages under it.
 */
export function useCallsList({
  tab,
  wide,
  listReady,
}: {
  tab: CallsTab;
  wide: boolean;
  listReady: boolean;
}) {
  const phone = useCalls();
  const [view, dispatch] = useReducer(
    listReducer as (
      v: ListView<CallRow> | null,
      a: ListAction<CallRow>
    ) => ListView<CallRow> | null,
    null
  );
  const key = `${tab}:${wide}`;
  // One count for every read of the screen (listReducer).
  const seqRef = useRef(0);
  const refresh = useCallback(() => {
    // The report tab loads its own figures; Unrouted waits for the role.
    if (!listReady) return;
    const seq = ++seqRef.current;
    loadCallsList<CallRow>(tab, wide, Date.now(), getJson)
      .then((list) => list && dispatch({ type: 'loaded', key, seq, list }))
      .catch(() => dispatch({ type: 'failed', key, seq }));
  }, [key, listReady, tab, wide]);
  const refresher = useRef<ReturnType<typeof startCallsRefresh> | null>(null);
  useEffect(() => {
    refresh();
    const r = startCallsRefresh(refresh, document, window);
    refresher.current = r;
    return () => {
      refresher.current = null;
      r.stop();
    };
  }, [refresh]);

  // The caller's calls in progress, as the call layer follows call_live:
  // the one ringing and the panel's. Answering moves a call from the
  // first to the second, so only one that ended leaves.
  const ringing = phone?.ringing;
  const panel = phone?.panel;
  const liveKeys = [
    ...(ringing ? [liveKey(ringing)] : []),
    ...(panel && panel.endedAt === null ? [panel.key] : []),
  ].join('\n');
  const liveBefore = useRef(liveKeys);
  useEffect(() => {
    const split = (k: string) => (k ? k.split('\n') : []);
    if (callLeft(split(liveBefore.current), split(liveKeys)))
      refresher.current?.soon();
    liveBefore.current = liveKeys;
  }, [liveKeys]);

  const current = view?.key === key ? view : null;
  const shown = current?.list ?? null;
  const last = shown?.calls.at(-1);
  const loadOlder = () => {
    if (!last || current?.older === 'loading') return;
    dispatch({ type: 'olderStarted', key });
    loadCallsList<CallRow>(tab, wide, Date.now(), getJson, last)
      .then(
        (list) => list && dispatch({ type: 'older', key, after: last.id, list })
      )
      .catch(() => dispatch({ type: 'olderFailed', key, after: last.id }));
  };

  return { current, shown, loadOlder, refresh };
}
