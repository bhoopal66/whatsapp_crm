/**
 * What the HR panel's "Automated messages" section shows for a chat's
 * consent record (pure). Message keys are relative to the `Hr` namespace.
 */
import type { AutoMsgConsentView, ConsentSource } from './api';
import {
  AUTOMSG_CHANNELS,
  CHANNEL_LABEL_KEYS,
  type AutomsgChannel,
} from './channel';

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

/** One channel's consent read: still loading, failed, or the record. */
export type ConsentRead =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ok'; consent: AutoMsgConsentView };

export type ConsentRow = { channel: AutomsgChannel; labelKey: string } & (
  { status: 'loading' | 'failed' } | ({ status: 'ok' } & ConsentPanel)
);

/**
 * One row per channel, WhatsApp first, each from its own consent read.
 * Opt-out (the contact) and a personal chat are not channel facts, so
 * either one, reported by any read, holds every row that loaded.
 * `labelKey` is relative to the `Hr` namespace.
 */
export function consentRows(
  reads: Readonly<Partial<Record<AutomsgChannel, ConsentRead>>>,
  canAct: boolean
): ConsentRow[] {
  const loaded = Object.values(reads).flatMap((r) =>
    r?.status === 'ok' ? [r.consent] : []
  );
  const personal = loaded.some((c) => c.personal);
  const optedOut = loaded.some((c) => c.optedOut);
  return AUTOMSG_CHANNELS.map((channel) => {
    const labelKey = `automsg.${CHANNEL_LABEL_KEYS[channel]}`;
    const read = reads[channel] ?? { status: 'loading' as const };
    if (read.status !== 'ok') return { channel, labelKey, status: read.status };
    return {
      channel,
      labelKey,
      status: 'ok' as const,
      ...consentPanel({ ...read.consent, personal, optedOut }, canAct),
    };
  });
}

/**
 * The note to show once in place of the rows when every row is held by
 * the same chat-wide rule (a personal chat, an opted-out candidate).
 */
export function sharedNotice(
  rows: readonly ConsentRow[]
): 'personal' | 'optedOut' | null {
  const kinds = new Set(
    rows.map((r) => (r.status === 'ok' ? r.state.kind : r.status))
  );
  if (kinds.size !== 1) return null;
  const [k] = kinds;
  return k === 'personal' || k === 'optedOut' ? k : null;
}

export const consentSourceKey = (s: ConsentSource) => `consent.source.${s}`;
