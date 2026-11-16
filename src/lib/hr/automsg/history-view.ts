/**
 * Pure view logic for the message history on the HR Automated messages
 * screen. The database decides every cancel (`hr_automsg_cancel`
 * re-checks the caller and the row); this only decides what a row shows
 * and offers. Client components import this file: types and constants
 * only.
 */
import type { HrErrorCode } from '@/lib/hr/types';

import type { AutoMsgOutboxRow } from './api';
import {
  OUTBOX_STATUSES,
  type ClaimState,
  type HoldReason,
  type OutboxStatus,
} from './types';
import { automsgErrorKey, type AutomsgRole } from './view';

/** Rows asked for, newest first. */
export const HISTORY_LIMIT = 100;

export const HISTORY_FILTERS = ['all', ...OUTBOX_STATUSES] as const;
export type HistoryFilter = (typeof HISTORY_FILTERS)[number];

/** The RPC's status argument for a filter chip ('all' = no filter). */
export function historyStatusArg(filter: HistoryFilter): OutboxStatus | null {
  return filter === 'all' ? null : filter;
}

/** Label keys under `automsg.history.hold`, one per hold reason. */
export const HOLD_REASON_KEYS: Readonly<Record<HoldReason, string>> = {
  kill_switch: 'killSwitch',
  disabled: 'disabled',
  closed: 'closed',
  opted_out: 'optedOut',
  no_consent: 'noConsent',
  quiet_hours: 'quietHours',
  outside_window_no_template: 'noTemplate',
  daily_cap: 'dailyCap',
  duplicate: 'duplicate',
};

/** Label keys under `automsg.history.claim`, one per claim state. */
export const CLAIM_STATE_KEYS: Readonly<Record<ClaimState, string>> = {
  sending: 'sending',
  unconfirmed: 'unconfirmed',
  needs_review: 'needsReview',
};

/** Statuses a person may still cancel (when no send has claimed the row). */
export const CANCELLABLE_STATUSES: readonly OutboxStatus[] = [
  'queued',
  'held',
  'failed',
];

export interface HistoryRowView {
  /** Key under `automsg.history.status`. */
  statusKey: OutboxStatus;
  /** Key under `automsg.history.hold`, or null. */
  holdKey: string | null;
  /** Key under `automsg.history.claim`, or null. */
  claimKey: string | null;
  canCancel: boolean;
  /** The candidate's chat in the HR inbox. */
  href: string;
}

export function historyRowView(
  row: Pick<
    AutoMsgOutboxRow,
    'status' | 'holdReason' | 'claimState' | 'conversationId'
  >,
  role: AutomsgRole | null
): HistoryRowView {
  return {
    statusKey: row.status,
    holdKey: row.holdReason ? HOLD_REASON_KEYS[row.holdReason] : null,
    claimKey: row.claimState ? CLAIM_STATE_KEYS[row.claimState] : null,
    canCancel:
      (role === 'admin' || role === 'lead') &&
      CANCELLABLE_STATUSES.includes(row.status) &&
      row.claimState === null,
    href: `/hr-inbox?c=${encodeURIComponent(row.conversationId)}`,
  };
}

/** A cancel refusal's label key under `Hr.automsg`. */
export function cancelErrorKey(code: HrErrorCode | string): string {
  if (code === 'ALREADY_DECIDED') return 'history.alreadyDecided';
  return `error.${automsgErrorKey(code)}`;
}
