/**
 * An inbound message (or own send) could not be stored, before the
 * `messages` idempotency boundary: nothing of it is in the inbox, so it is
 * safe, and needed, to process it again. Thrown only where the caller asked
 * for it (`onPersistFailure: 'throw'`). Carries no customer text.
 *
 * `opt_out` is the one stage after the boundary: the message is stored and
 * everything else ran, but a candidate's STOP could not be stamped. The
 * retry finds the message stored and repeats the stamp only.
 */
export type InboundPersistStage =
  'contact' | 'conversation' | 'message' | 'opt_out';

export class InboundPersistError extends Error {
  constructor(
    readonly stage: InboundPersistStage,
    /** The database's error code, when it gave one. */
    readonly code: string | null = null
  ) {
    super(`inbound ${stage} could not be stored${code ? ` (${code})` : ''}`);
    this.name = 'InboundPersistError';
  }
}
