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

interface CustomerDocumentFields {
  accountId: string;
  contactId: string;
  kind: CustomerDocumentKind | null;
  /** The durable URL stored on the message row. */
  mediaUrl: string | null;
  mime: string | null;
  originalName: string | null;
  caption: string | null;
  /** ISO timestamp, the same one written to the row's `created_at`. */
  receivedAt: string;
}

/** A document from the customer's 1:1 chat. */
export interface ChatCustomerDocumentInput extends CustomerDocumentFields {
  source: 'chat';
  conversationId: string;
  /** The `messages` row id, not the WhatsApp message id. */
  messageRowId: string;
}

/** A document the customer sent into their submission group (115). */
export interface GroupCustomerDocumentInput extends CustomerDocumentFields {
  source: 'submission_group';
  /** The `submission_group_messages` row id (bigint identity). */
  groupMessageId: number;
}

export type CustomerDocumentInput =
  ChatCustomerDocumentInput | GroupCustomerDocumentInput;

/** The ids the RPC takes for this source, and the one the log line names. */
function sourceArgs(input: CustomerDocumentInput): {
  ids: Record<string, string | number | null>;
  label: string;
} {
  if (input.source === 'submission_group') {
    return {
      ids: {
        p_conversation_id: null,
        p_message_id: null,
        p_group_message_id: input.groupMessageId,
      },
      label: `group message ${input.groupMessageId}`,
    };
  }
  return {
    ids: {
      p_conversation_id: input.conversationId,
      p_message_id: input.messageRowId,
    },
    label: `message ${input.messageRowId}`,
  };
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
  const { ids, label } = sourceArgs(input);

  try {
    const { data, error } = await admin.rpc('customer_documents_record', {
      p_account_id: input.accountId,
      p_contact_id: input.contactId,
      p_source: input.source,
      p_kind: input.kind,
      p_media_url: mediaUrl,
      p_received_at: input.receivedAt,
      ...ids,
      p_mime: blankToNull(input.mime),
      p_original_name: blankToNull(input.originalName),
      p_caption: blankToNull(input.caption),
    });
    if (error) {
      console.error(
        `[customer-docs] record failed for ${label}: ${error.message}`
      );
      return null;
    }
    return typeof data === 'string' ? data : null;
  } catch (err) {
    console.error(
      `[customer-docs] record failed for ${label}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}
