import type { Category, Product } from './schema';

export const NEW_STATE = 'NEW';

export interface Timer {
  kind: string;
  fireAt: string;
  state: string;
}
export interface HistoryEntry {
  at: string;
  from: string;
  to: string;
  cause: string;
}
export interface JourneyFile {
  id: string;
  contactId: string;
  workspaceId: string;
  product: Product | null;
  /** null until the first entry event (INBOUND message or START_COLD). */
  entry: 'INBOUND' | 'COLD' | null;
  state: string;
  prevOpenState: string | null;
  window: { lastInboundAt: string | null; freeEntryUntil: string | null };
  counters: {
    reengageSent: number;
    remindersThisStage: number;
    paidSends: number;
    paidAfterParked: number;
  };
  timers: Timer[];
  /** Expiry of the quote/offer each validity slot last issued (StateDef.validity.slot → ISO instant). */
  validUntil: Record<string, string>;
  outcome: null | { kind: 'WON' | 'NOT_WON' | 'PARKED'; reason: string };
  optedOut: boolean;
  /** When the last REQUEST_CALLBACK was raised (CALL_ME_BACK throttle); absent until the first. */
  lastCallbackAt?: string;
  history: HistoryEntry[];
  /** Optimistic-concurrency version: 0 for a new file; `step` leaves it; the store increments it on each commit. */
  version: number;
}

export type AdvisorDecision =
  | 'FIT'
  | 'NO_FIT'
  | 'QUOTE_READY'
  | 'COMPARISON_READY'
  | 'DOCS_COMPLETE'
  | 'SUBMITTED'
  | 'PARTNER_APPROVED'
  | 'PARTNER_MORE_INFO'
  | 'PARTNER_DECLINED'
  | 'FULFILMENT_SCHEDULED'
  | 'CLOSE';

export type JourneyEvent =
  | { type: 'INBOUND_TEXT'; text: string; at: string; freeEntry?: boolean }
  | { type: 'BUTTON'; payload: string; at: string }
  | { type: 'MEDIA'; count: number; at: string }
  /** validUntil: quote validity / offer expiry set by the host (arms `validUntil` timers). */
  | {
      type: 'ADVISOR';
      decision: AdvisorDecision;
      reasonCode?: string;
      validUntil?: string;
      at: string;
      by: string;
    }
  | { type: 'TIMER'; kind: string; at: string }
  | { type: 'START_COLD'; at: string };

export interface StepContext {
  /** doNotContact (default false): host do-not-contact flag — a CALL_ME_BACK then raises only a CALLBACK_BLOCKED_DNC task. */
  consent: {
    marketingOptIn: boolean;
    optedOut: boolean;
    doNotContact?: boolean;
  };
  contactHasReceivedOptinWelcome: boolean;
  /** Host-chosen template variant (e.g. "intro" | "switch"). */
  variant?: string;
}

export type Action =
  /** variant: copy key within the template (e.g. callback_ack IN_HOURS | OUT_OF_HOURS). */
  | {
      type: 'SEND';
      template: string;
      category: Category;
      billable: boolean;
      notBefore?: string;
      variant?: string;
    }
  | { type: 'ADVISOR_TASK'; kind: string; dueAt: string; note: string }
  | { type: 'SET_TIMER'; kind: string; fireAt: string }
  | { type: 'CANCEL_TIMERS'; all: true }
  /** Cancels pending timers of these kinds (emitted before a re-arm of the same kind). */
  | { type: 'CANCEL_TIMERS'; kinds: string[] }
  | {
      type: 'START_NEW_JOURNEY';
      contactId: string;
      entry: 'INBOUND';
      cause: string;
    }
  | { type: 'CLOSE'; outcome: 'WON' | 'NOT_WON'; reason: string }
  | { type: 'LOG_COST'; template: string; category: Category }
  /** Host updates its consent register (opt-out keyword / START). */
  | { type: 'SET_OPT_OUT'; optedOut: boolean }
  /** Emitted immediately before the `taamul_optin_welcome` send; host records it atomically per contact. */
  | { type: 'MARK_OPTIN_WELCOME_SENT'; contactId: string }
  /** CALL_ME_BACK: host hands it to module 015 (Yeastar click-to-call: RM first, then customer); notBefore = not before then. */
  | {
      type: 'REQUEST_CALLBACK';
      contactId: string;
      fileId: string;
      notBefore?: string;
    };

export interface Warning {
  code: string;
  message: string;
}
export interface StepResult {
  file: JourneyFile;
  actions: Action[];
  warnings: Warning[];
  error?: Warning;
}
