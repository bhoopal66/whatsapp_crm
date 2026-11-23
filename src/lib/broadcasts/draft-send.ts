/**
 * Sending and saving a reopened broadcast draft. Pure orchestration: the
 * page passes the database calls in.
 *
 * The draft row is the claim token. Two tabs (or two admins) can have the
 * same draft open, so the row is deleted BEFORE a campaign is created:
 * only the delete that gets the row back may send.
 */

type DbError = { message: string; code?: string } | null;
type IdRows = { data: { id: string }[] | null; error: DbError };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type SaveDraftResult =
  | { kind: 'saved'; id: string }
  /** Another tab sent or deleted it: nothing was written. */
  | { kind: 'gone' }
  /** `id`: the row a retry must update, so it never leaves two. */
  | { kind: 'failed'; id: string | null; message: string };

export interface SaveDraftDeps {
  draftId: string | null;
  /** Conditional on `status = 'draft'`, returning the rows it touched. */
  update: (id: string) => PromiseLike<IdRows>;
  insert: () => PromiseLike<{ data: { id: string } | null; error: DbError }>;
  saveState: (id: string) => PromiseLike<{ error: DbError }>;
}

export async function saveDraft(deps: SaveDraftDeps): Promise<SaveDraftResult> {
  let id = deps.draftId;
  try {
    if (id) {
      const { data, error } = await deps.update(id);
      if (error) return { kind: 'failed', id, message: error.message };
      // Never insert here: the other tab's send has already used it.
      if (!data?.length) return { kind: 'gone' };
    } else {
      const { data, error } = await deps.insert();
      if (error || !data) {
        return { kind: 'failed', id, message: error?.message ?? 'no row' };
      }
      id = data.id;
    }
    const { error } = await deps.saveState(id);
    if (!error) return { kind: 'saved', id };
    // The row went between the two writes (its foreign key is the proof).
    if (error.code === '23503') return { kind: 'gone' };
    return { kind: 'failed', id, message: error.message };
  } catch (err) {
    return { kind: 'failed', id, message: errorText(err) };
  }
}

export type SendDraftResult<T> =
  | { kind: 'sent'; outcome: T }
  | { kind: 'claim_lost' }
  | { kind: 'claim_failed'; message: string }
  | {
      kind: 'failed';
      error: unknown;
      /** Set once the campaign row exists: it is resumed from its page. */
      campaignId: string | null;
      /** What became of the claimed draft; null when there is none. */
      restored: SaveDraftResult | null;
    };

export interface SendDraftDeps<T> {
  draftId: string | null;
  /** Conditional delete (`status = 'draft'`) returning the deleted rows. */
  claim: (id: string) => PromiseLike<IdRows>;
  /** Must report the campaign row as soon as it exists. */
  create: (onCampaignCreated: (id: string) => void) => Promise<T>;
  /** Saves the wizard as a new draft (the claimed row is gone). */
  restore: () => Promise<SaveDraftResult>;
}

export async function sendReopenedDraft<T>(
  deps: SendDraftDeps<T>
): Promise<SendDraftResult<T>> {
  if (deps.draftId) {
    try {
      const { data, error } = await deps.claim(deps.draftId);
      if (error) return { kind: 'claim_failed', message: error.message };
      if (!data?.length) return { kind: 'claim_lost' };
    } catch (err) {
      return { kind: 'claim_failed', message: errorText(err) };
    }
  }

  let campaignId: string | null = null;
  try {
    const outcome = await deps.create((id) => {
      campaignId = id;
    });
    return { kind: 'sent', outcome };
  } catch (error) {
    // A draft beside an existing campaign is the double send again: the
    // campaign's own page resumes whatever it did not deliver.
    const restored = deps.draftId && !campaignId ? await deps.restore() : null;
    return { kind: 'failed', error, campaignId, restored };
  }
}
