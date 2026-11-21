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

type Admin = Pick<SupabaseClient, 'rpc'> & { storage: CaseFilesStorage };

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
  /** The customer_documents row 178 just recorded. */
  documentId: string;
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

/** Routes one recorded document. Never throws; null on any failure. */
export async function routeDeskDocument(
  admin: Admin,
  input: DeskDocumentInput,
  store: DeskStore = new DeskStore(admin as unknown as SupabaseClient)
): Promise<RouteDecision | null> {
  let decision: RouteDecision;
  try {
    decision = await store.routeDocument(
      input.accountId,
      input.documentId,
      input.channelId
    );
  } catch (err) {
    console.error(
      `[desk] route failed: ${err instanceof Error ? err.name : typeof err}`
    );
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
      itemId: input.documentId,
      idemKey: `wa:${input.documentId}`,
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
  }
  return decision;
}
