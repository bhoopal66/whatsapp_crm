/**
 * WhatsApp documents to the case desk (migration 230, design 035 slice
 * C), called from inbound-pipeline.ts once a customer's 1:1 document is
 * recorded (178). The SQL decides (desk_route_customer_document): file
 * to the one case the evidence names, put it in the tray with its
 * candidates, ignore it, or hand a STAFF phone's document to the staff
 * upload below.
 *
 * A staff member's WhatsApp document becomes a desk upload in their name
 * (220's intake, channel 'whatsapp'), tagged from its caption exactly as
 * the upload form's caption field is (`mergeCaption`); anything the
 * caption does not settle waits in the sorting queue. The item id is the
 * customer document's id, so a redelivery replays instead of uploading
 * twice.
 *
 * Bytes are read only from this install's own storage
 * (`readDocumentBytes`), never from an arbitrary URL.
 *
 * Never throws: a webhook that throws makes the gateway redeliver and
 * re-run the whole fan-out.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  readDocumentBytes,
  type CaseFilesStorage,
} from '@/lib/case-files/bytes';

import { mergeCaption } from './intake-form';
import {
  DeskRefusedError,
  DeskStore,
  type ItemResult,
  type ItemTags,
} from './store';
import type { RouteDecision } from './tray';
import { prepareIntakeFile, storeIntakeFile } from './upload';

type Admin = Pick<SupabaseClient, 'from' | 'rpc'> & {
  storage: CaseFilesStorage;
};

const EMPTY_TAGS: ItemTags = {
  kind: null,
  bankCode: null,
  caseRef: null,
  companyName: null,
  tradeLicence: null,
  product: null,
  contactId: null,
  docKey: null,
  note: null,
};

export interface DeskDocumentInput {
  accountId: string;
  /** The messages row the document arrived on (178 files one per message). */
  messageRowId: string;
  /** The number it arrived on (desk numbers take unknown senders). */
  channelId: string | null;
  mediaUrl: string;
  mime: string | null;
  originalName: string | null;
  caption: string | null;
}

export interface CopyMedia {
  mediaUrl: string;
  mime: string | null;
  originalName: string | null;
}

/**
 * Reads a stored WhatsApp document and submits it to the desk intake in
 * `actor`'s name, as having arrived by WhatsApp. Throws DeskRefusedError
 * FILE_INVALID when the bytes cannot be read or are not an accepted file.
 */
export async function copyIntoIntake(
  admin: Admin,
  store: DeskStore,
  input: {
    actor: string;
    accountId: string;
    itemId: string;
    idemKey: string;
    tags: ItemTags;
    media: CopyMedia;
  }
): Promise<ItemResult> {
  const bytes = await readDocumentBytes(
    { mediaUrl: input.media.mediaUrl, storageBucket: null, storagePath: null },
    { storage: admin.storage }
  );
  if (!bytes) throw new DeskRefusedError('FILE_INVALID');
  const file = prepareIntakeFile(input.itemId, {
    bytes,
    mime: input.media.mime ?? '',
    originalName: input.media.originalName ?? 'whatsapp-document',
  });
  await storeIntakeFile(admin.storage, file, bytes);
  return store.whatsappIntake(input.actor, input.accountId, {
    itemId: input.itemId,
    idemKey: input.idemKey,
    tags: input.tags,
    file,
  });
}

/**
 * The id of the customer_documents row 178 recorded for this message.
 * Read here because `customer_documents_record` answers the customer's
 * FOLDER reference ('TC-000123'), never the row: handing that to the
 * router failed every call (22P02 on its uuid argument).
 */
async function recordedDocumentId(
  admin: Admin,
  input: DeskDocumentInput
): Promise<string> {
  const { data, error } = await admin
    .from('customer_documents')
    .select('id')
    .eq('account_id', input.accountId)
    .eq('message_id', input.messageRowId)
    .maybeSingle();
  const id = (data as { id?: unknown } | null)?.id;
  if (error || typeof id !== 'string') throw new DeskDocumentMissingError();
  return id;
}

class DeskDocumentMissingError extends Error {
  override name = 'DeskDocumentMissingError';
}

/**
 * A failed document is never lost to the desk (303): inbound is not
 * retried, so it becomes a tray row a sorter sees. Tried twice; the SQL
 * leaves a document that was filed or copied after all. Never throws.
 */
async function traceInTray(
  store: DeskStore,
  input: DeskDocumentInput
): Promise<void> {
  const { accountId, messageRowId, channelId } = input;
  for (const last of [false, true]) {
    try {
      if (!(await store.trayCopyFailed(accountId, messageRowId, channelId)))
        console.error(`[desk] no document recorded for ${messageRowId}`);
      return;
    } catch {
      if (last) console.error(`[desk] no tray row for message ${messageRowId}`);
      else await new Promise((done) => setTimeout(done, 250));
    }
  }
}

/** Routes one recorded document. Never throws; null on any failure. */
export async function routeDeskDocument(
  admin: Admin,
  input: DeskDocumentInput,
  store: DeskStore = new DeskStore(admin as unknown as SupabaseClient)
): Promise<RouteDecision | null> {
  let decision: RouteDecision;
  let documentId: string;
  try {
    documentId = await recordedDocumentId(admin, input);
    decision = await store.routeDocument(
      input.accountId,
      documentId,
      input.channelId
    );
  } catch (err) {
    console.error(
      `[desk] route failed: ${err instanceof Error ? err.name : typeof err}`
    );
    await traceInTray(store, input);
    return null;
  }
  if (decision.action !== 'staff' || !decision.staffUserId) return decision;

  try {
    const merged = mergeCaption(EMPTY_TAGS, input.caption);
    const tags = { ...merged.tags };
    if (merged.deskCode && tags.bankCode === null)
      tags.bankCode = await store.bankByShortCode(
        input.accountId,
        merged.deskCode
      );
    await copyIntoIntake(admin, store, {
      actor: decision.staffUserId,
      accountId: input.accountId,
      itemId: documentId,
      idemKey: `wa:${documentId}`,
      tags,
      media: input,
    });
  } catch (err) {
    // The name only: a storage or database message can carry a path.
    console.error(
      `[desk] staff WhatsApp upload failed: ${
        err instanceof Error
          ? `${err.name}${'reason' in err ? ` ${String(err.reason)}` : ''}`
          : typeof err
      }`
    );
    await traceInTray(store, input);
  }
  return decision;
}
