import type { Action, JourneyEvent, JourneyFile } from './types';

/** Host consent register. */
export interface ConsentPort {
  hasMarketingOptIn(contactId: string): Promise<boolean>;
  isOptedOut(contactId: string): Promise<boolean>;
  /** Cap: `taamul_optin_welcome` once per contact, ever. */
  hasReceivedOptinWelcome(contactId: string): Promise<boolean>;
  /**
   * Atomic delivery-time claim of the once-per-contact opt-in welcome: true iff the contact's welcome is unclaimed (it is
   * now claimed by `claimId`) or already claimed by this same `claimId` (a redelivery of the same outbox item).
   */
  claimOptinWelcome(contactId: string, claimId: string): Promise<boolean>;
  /** Host do-not-contact flag; feeds `StepContext.consent.doNotContact`. Absent: never do-not-contact. */
  doNotContact?(contactId: string): Promise<boolean>;
}

/** One persisted action awaiting (or done with) delivery. `id` is stable and unique; `seq` orders a file's items. */
export interface OutboxItem {
  id: string;
  fileId: string;
  seq: number;
  action: Action;
  /** `dropped`: refused at delivery time by the consent re-check (never delivered); `dropReason` says why. */
  status: 'pending' | 'delivered' | 'dropped';
  dropReason?: string;
}

export type CommitResult = 'ok' | 'duplicate' | 'conflict';

/** Persistence with a transactional outbox (see README_016.md, host contract). */
export interface JourneyStore {
  load(fileId: string): Promise<JourneyFile | null>;
  /**
   * Atomically: if `eventId` was already processed for `fileAfter.id` → "duplicate" (checked before the version);
   * else if the stored version ≠ `expectedVersion` → "conflict"; else store `fileAfter` with version
   * `expectedVersion + 1`, record `eventId` as processed and append `actions` as pending outbox items
   * (in order, with increasing `seq`) → "ok". Nothing is written unless the result is "ok".
   */
  commit(
    expectedVersion: number,
    fileAfter: JourneyFile,
    eventId: string,
    actions: Action[]
  ): Promise<CommitResult>;
  /** The file's pending items (any order; the runner sorts by `seq`). */
  pendingOutbox(fileId: string): Promise<OutboxItem[]>;
  markDelivered(itemId: string): Promise<void>;
  markDropped(itemId: string, reason: string): Promise<void>;
  /**
   * The `optedOut` value of the contact's most recently committed SET_OPT_OUT item that is still pending, on any of the
   * contact's files; null when none is pending. Lets a delivery-time re-check see an opt-out the register has not got yet.
   */
  pendingOptOut(contactId: string): Promise<boolean | null>;
}

/** Executes one outbox item (Meta send, task creation, scheduler, cost log via module 011). */
export interface ActionSink {
  /** Must be idempotent by `item.id`: a redelivered item (crash between deliver and markDelivered) is a no-op host-side. */
  deliver(item: OutboxItem): Promise<void>;
}

export type RunnerEvent = JourneyEvent & { id: string; fileId: string };
