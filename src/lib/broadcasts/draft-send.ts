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
  /** Must report the campaign once it stands (`completeCampaign`). */
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

export interface CompleteCampaignDeps<T> {
  /** Everything until every recipient row exists; nothing is sent in it. */
  prepare: () => Promise<T>;
  /** Sent from a claimed draft, whose only copy is now this wizard. */
  fromDraft: boolean;
  /** Deletes the campaign row (its recipients cascade), returning it. */
  discard: () => PromiseLike<IdRows>;
  /** Marks the campaign row failed. */
  markFailed: () => PromiseLike<unknown>;
  onCampaignCreated: () => void;
}

/**
 * A campaign is only "created" once every recipient row exists: its page
 * resumes the rows it has, so a campaign cut short while they were being
 * written would silently never reach the rest. Cut short, one sent from a
 * draft is deleted, so the draft can be restored; if that cannot be
 * confirmed the campaign stands (as failed) and the draft does not come
 * back beside it, which could send twice.
 */
export async function completeCampaign<T>(
  deps: CompleteCampaignDeps<T>
): Promise<T> {
  let out: T;
  try {
    out = await deps.prepare();
  } catch (error) {
    let discarded = false;
    if (deps.fromDraft) {
      try {
        const { data, error: failed } = await deps.discard();
        discarded = !failed && !!data?.length;
      } catch {
        // Unknown: treated as still there.
      }
    }
    if (!discarded) {
      try {
        await deps.markFailed();
      } catch {
        // The error below is the one worth showing.
      }
      deps.onCampaignCreated();
    }
    throw error;
  }
  deps.onCampaignCreated();
  return out;
}
