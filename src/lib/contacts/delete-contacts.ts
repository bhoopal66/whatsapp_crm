// The calls behind the customers' delete dialog: the preview it shows and
// the delete itself. The words and rules are in `delete-preview.ts`.

import type { SupabaseClient } from '@supabase/supabase-js';

import { deleteRows, type RowWriter } from '@/lib/supabase/changed-rows';
import {
  DELETE_PREVIEW_RPC,
  deleteRefusal,
  parseDeletePreview,
  splitDeletable,
  type BlockedContact,
  type DeletePreview,
  type PreviewState,
} from './delete-preview';

type Rpc = Pick<SupabaseClient, 'rpc'>;

async function readPreview(
  sb: Rpc,
  ids: readonly string[]
): Promise<DeletePreview | null> {
  const { data, error } = await sb.rpc(DELETE_PREVIEW_RPC, {
    p_contacts: ids,
  });
  return error ? null : parseDeletePreview(data);
}

/**
 * What deleting these customers does. Some blocked: the counts are read
 * again for the others alone, or the dialog would announce the loss of
 * chats it is about to keep. If that second read fails, no counts.
 */
export async function loadDeletePreview(
  sb: Rpc,
  ids: readonly string[]
): Promise<PreviewState> {
  const all = await readPreview(sb, ids);
  if (!all) return { kind: 'failed' };
  const { deletable, blocked } = splitDeletable(ids, all.blocked);
  if (blocked.length === 0 || deletable.length === 0)
    return { kind: 'ready', preview: all };
  const rest = await readPreview(sb, deletable);
  return {
    kind: 'ready',
    preview: {
      chats: 0,
      tasks: 0,
      dealRooms: 0,
      deals: 0,
      documents: 0,
      cases: 0,
      ...rest,
      blocked: [...all.blocked, ...(rest?.blocked ?? [])],
    },
  };
}

/** Ids in none of the three were not there (or not theirs) to delete. */
export interface DeleteOutcome {
  deleted: string[];
  refused: BlockedContact[];
  failed: string[];
}

/**
 * Deletes these customers. One refused row fails the whole statement, so a
 * refusal asks for each on its own, one at a time: the rest still go, and
 * whoever stays is named with their reason.
 */
export async function deleteContacts(
  sb: RowWriter,
  ids: readonly string[]
): Promise<DeleteOutcome> {
  const out: DeleteOutcome = { deleted: [], refused: [], failed: [] };
  const ask = async (asked: string[]) => {
    const res = await deleteRows(sb, 'contacts', asked);
    if (res.kind === 'changed') out.deleted.push(...res.ids);
    if (res.kind !== 'failed') return;
    const refusal = deleteRefusal(res.error);
    if (!refusal) out.failed.push(...asked);
    else if (asked.length === 1) out.refused.push({ id: asked[0], ...refusal });
    else for (const id of asked) await ask([id]);
  };
  await ask([...ids]);
  return out;
}
