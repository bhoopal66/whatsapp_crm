import type { SupabaseClient } from '@supabase/supabase-js';

import type { NormalizedMessageType } from '@/lib/whatsapp/inbound';

/** What a customer sent that is filed in their documents folder. */
export type CustomerDocumentKind = 'document' | 'image';

/**
 * The folder kind for an inbound message, from its NORMALISED type, not
 * the stored `content_type`: a sticker is stored as content_type 'image'
 * (it has no column value of its own) and is not a document. Audio,
 * voice notes, video and text are not filed either.
 */
export function customerDocumentKind(
  normalizedType: NormalizedMessageType | string
): CustomerDocumentKind | null {
  if (normalizedType === 'document') return 'document';
  if (normalizedType === 'image') return 'image';
  return null;
}

export interface CustomerDocumentInput {
  accountId: string;
  contactId: string;
  conversationId: string;
  /** The `messages` row id, not the WhatsApp message id. */
  messageRowId: string;
  source: 'chat';
  kind: CustomerDocumentKind | null;
  /** The durable URL stored on the message row. */
  mediaUrl: string | null;
  mime: string | null;
  originalName: string | null;
  caption: string | null;
  /** ISO timestamp, the same one written to the row's `created_at`. */
  receivedAt: string;
}

function blankToNull(value: string | null): string | null {
  return value && value.trim() !== '' ? value : null;
}

/**
 * Record one customer document through `customer_documents_record`
 * (migration 178, service role); a worker later copies the file into the
 * customer's folder. Returns the folder reference, or null when there is
 * nothing to record or the call failed. Never throws: a document that
 * was not filed is never worth losing or redelivering the message over.
 * The RPC is idempotent per message row. The one log line names the
 * message row only: no URL, no customer text.
 */
export async function recordCustomerDocument(
  admin: Pick<SupabaseClient, 'rpc'>,
  input: CustomerDocumentInput
): Promise<string | null> {
  if (!input.kind) return null;
  const mediaUrl = blankToNull(input.mediaUrl);
  if (!mediaUrl) return null;

  try {
    const { data, error } = await admin.rpc('customer_documents_record', {
      p_account_id: input.accountId,
      p_contact_id: input.contactId,
      p_source: input.source,
      p_kind: input.kind,
      p_media_url: mediaUrl,
      p_received_at: input.receivedAt,
      p_conversation_id: input.conversationId,
      p_message_id: input.messageRowId,
      p_mime: blankToNull(input.mime),
      p_original_name: blankToNull(input.originalName),
      p_caption: blankToNull(input.caption),
    });
    if (error) {
      console.error(
        `[customer-docs] record failed for message ${input.messageRowId}: ${error.message}`
      );
      return null;
    }
    return typeof data === 'string' ? data : null;
  } catch (err) {
    console.error(
      `[customer-docs] record failed for message ${input.messageRowId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}
