'use client';

import { useEffect, useMemo, useState } from 'react';

import {
  classifyCaseRef,
  isLookupReady,
  type CaseRefState,
} from '@/lib/desk/case-ref';
import type { CaseLookup } from '@/lib/desk/store';

import { deskApi } from './desk-api';

export const LOOKUP_DEBOUNCE_MS = 350;

export type CaseLookupState =
  | { status: 'idle' }
  | { status: 'typing'; ref: CaseRefState }
  | { status: 'loading' }
  | { status: 'found'; found: CaseLookup }
  /** No such case, or one the caller may not see (the server says the same). */
  | { status: 'not_found' }
  /** The caller is not a sorter: no preview, the upload is checked on send. */
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/**
 * Look a case up as its number is typed: the text is parsed first
 * (`classifyCaseRef`, so a half-typed or mistyped code never reaches the
 * server), then asked after a pause. Access is the server's: the same
 * lookup the sorting queue uses, confined to the caller's banks and
 * readable cases.
 */
export function useCaseLookup(raw: string): CaseLookupState {
  const parsed = useMemo(() => classifyCaseRef(raw), [raw]);
  const ref = isLookupReady(parsed) ? parsed.ref : null;
  const [done, setDone] = useState<{
    ref: string;
    state: CaseLookupState;
  } | null>(null);

  useEffect(() => {
    if (!ref) return;
    let live = true;
    const timer = setTimeout(() => {
      void deskApi.lookup(ref).then((r) => {
        if (!live) return;
        let state: CaseLookupState;
        if (r.ok)
          state = r.data
            ? { status: 'found', found: r.data }
            : { status: 'not_found' };
        else if (r.code === 'NOT_ALLOWED') state = { status: 'unavailable' };
        else state = { status: 'error', message: r.error };
        setDone({ ref, state });
      });
    }, LOOKUP_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [ref]);

  if (parsed.kind === 'empty') return { status: 'idle' };
  if (!ref) return { status: 'typing', ref: parsed };
  if (done && done.ref === ref) return done.state;
  return { status: 'loading' };
}
