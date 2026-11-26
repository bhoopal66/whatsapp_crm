'use client';

import { useMemo, useRef, useState } from 'react';

/** The note being written on one case. */
export interface NoteDraft {
  body: string;
  busy: boolean;
  setBody: (next: string) => void;
  /** True for the one post that may go out now; pair it with `end`. */
  begin: () => boolean;
  end: () => void;
  /** A post went through: clears the text unless it was changed meanwhile. */
  posted: (text: string) => void;
}

/**
 * The note drafts, per case. Held by the case page, not by the notes tab:
 * a tab is unmounted when the person opens another one, which lost the
 * text typed so far and forgot that a post was still on its way.
 */
export function useNoteDrafts(caseId: string): NoteDraft {
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<Record<string, boolean>>({});
  // The guard itself: two key presses can land before a render.
  const inFlight = useRef<Set<string>>(new Set());
  const body = bodies[caseId] ?? '';
  const busy = sending[caseId] === true;
  return useMemo(
    () => ({
      body,
      busy,
      setBody: (next) => setBodies((all) => ({ ...all, [caseId]: next })),
      begin: () => {
        if (inFlight.current.has(caseId)) return false;
        inFlight.current.add(caseId);
        setSending((all) => ({ ...all, [caseId]: true }));
        return true;
      },
      end: () => {
        inFlight.current.delete(caseId);
        setSending((all) => ({ ...all, [caseId]: false }));
      },
      posted: (text) =>
        setBodies((all) =>
          (all[caseId] ?? '').trim() === text ? { ...all, [caseId]: '' } : all
        ),
    }),
    [caseId, body, busy]
  );
}
