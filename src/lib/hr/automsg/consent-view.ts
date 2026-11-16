/**
 * What the HR panel's "Automated messages" section shows for a chat's
 * consent record (pure). Message keys are relative to the `Hr` namespace.
 */
import type { AutoMsgConsentView, ConsentSource } from './api';

export const CONSENT_SOURCES: readonly ConsentSource[] = [
  'recruiter_confirmed',
  'candidate_wrote',
  'form',
];

export type ConsentState =
  | { kind: 'personal' }
  | { kind: 'optedOut' }
  | { kind: 'given'; source: ConsentSource | null; notedAt: string | null }
  | { kind: 'withdrawn'; notedAt: string | null }
  | { kind: 'none' };

export interface ConsentPanel {
  state: ConsentState;
  canRecord: boolean;
  canWithdraw: boolean;
}

/**
 * A personal number never sends automated messages and an opted-out
 * candidate gets none, so neither offers a button.
 */
export function consentPanel(
  c: AutoMsgConsentView,
  canAct: boolean
): ConsentPanel {
  if (c.personal) {
    return {
      state: { kind: 'personal' },
      canRecord: false,
      canWithdraw: false,
    };
  }
  if (c.optedOut) {
    return {
      state: { kind: 'optedOut' },
      canRecord: false,
      canWithdraw: false,
    };
  }
  const state: ConsentState =
    c.granted === true
      ? { kind: 'given', source: c.source, notedAt: c.notedAt }
      : c.granted === false
        ? { kind: 'withdrawn', notedAt: c.notedAt }
        : { kind: 'none' };
  return {
    state,
    canRecord: canAct && c.granted !== true,
    canWithdraw: canAct && c.granted === true,
  };
}

export const consentSourceKey = (s: ConsentSource) => `consent.source.${s}`;
