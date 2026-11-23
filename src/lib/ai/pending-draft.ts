// ============================================================
// Acting on a held AI draft: what the route
// (`api/ai/pending-draft/[conversationId]`) and the inbox banner agree
// on. Pure.
// ============================================================

/** 409: the stored draft is not the one the person was shown. */
export const DRAFT_CHANGED = 'draft_changed';
/** 409: nothing is held any more (someone else sent or discarded it). */
export const DRAFT_GONE = 'draft_gone';
/** The send may have reached the customer; the draft is not restored. */
export const DRAFT_SEND_UNCONFIRMED = 'send_unconfirmed';
/** The send reached WhatsApp but its message row could not be saved. */
export const DRAFT_SENT_UNSAVED = 'db_error';

/**
 * The draft shown is the draft stored, by the time it was held. Two
 * spellings of one instant are the same: PostgREST and a realtime
 * payload may write a timestamptz differently.
 */
export function sameDraftTime(
  shown: string | null,
  stored: string | null
): boolean {
  if (shown === null || stored === null) return shown === stored;
  if (shown === stored) return true;
  const a = Date.parse(shown);
  return !Number.isNaN(a) && a === Date.parse(stored);
}

export interface DraftFields {
  ai_pending_draft: string | null;
  ai_pending_draft_at: string | null;
}

/** What the banner does with a refused send or discard. */
export type DraftFailure =
  /** The draft still stands: keep showing it. */
  | { kind: 'failed'; error: string | null }
  /** Sent or discarded by someone else: take it off the banner. */
  | { kind: 'gone'; error: string | null }
  /** Another draft is held now: show that one. */
  | { kind: 'changed'; draft: DraftFields }
  /** Never offer it again: it may be with the customer, or is. */
  | { kind: 'maybeSent' }
  | { kind: 'sentUnsaved' };

const text = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : null;

export function draftFailure(status: number, body: unknown): DraftFailure {
  const b = (body && typeof body === 'object' ? body : {}) as Record<
    string,
    unknown
  >;
  if (b.code === DRAFT_SEND_UNCONFIRMED) return { kind: 'maybeSent' };
  if (b.code === DRAFT_SENT_UNSAVED) return { kind: 'sentUnsaved' };
  const held = text(b.ai_pending_draft);
  if (status === 409 && b.code === DRAFT_CHANGED && held) {
    return {
      kind: 'changed',
      draft: {
        ai_pending_draft: held,
        ai_pending_draft_at: text(b.ai_pending_draft_at),
      },
    };
  }
  // The send core answers 409 too (a personal chat, say), with the draft
  // put back: only this code says it is gone.
  if (status === 409 && b.code === DRAFT_GONE) {
    return { kind: 'gone', error: text(b.error) };
  }
  return { kind: 'failed', error: text(b.error) };
}
