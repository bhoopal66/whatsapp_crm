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

// ------------------------------------------------- internal (180)

interface InternalCustomerDocumentFields {
  accountId: string;
  contactId: string;
  kind: CustomerDocumentKind;
  /** The private bucket the bytes are in; 180 accepts only this one. */
  storageBucket: 'case-files';
  /** Object path inside the bucket: not blank, no leading '/', no '..'. */
  storagePath: string;
  /** ISO timestamp the file was received or built. */
  receivedAt: string;
  mime?: string | null;
  originalName?: string | null;
}

/** A file a staff member uploaded to a case or to the customer. */
export interface StaffUploadDocumentInput extends InternalCustomerDocumentFields {
  source: 'staff_upload';
  /** The uploader's auth user id: live staff of the account. */
  uploadedBy: string;
  caseId?: string | null;
}

/** A case-file PDF the CRM assembled for a case. */
export interface CaseBuildDocumentInput extends InternalCustomerDocumentFields {
  source: 'case_build';
  /** The case, whose contact must be `contactId`. */
  caseId: string;
}

export type InternalCustomerDocumentInput =
  StaffUploadDocumentInput | CaseBuildDocumentInput;

/**
 * Why `customer_documents_record_internal` refused or failed. `hint` is
 * the function's HINT ('INVALID', 'NOT_FOUND'), or null for anything
 * else (a transport failure, a permission error), so a route can answer
 * 4xx for a refusal and 5xx otherwise.
 */
export class CustomerDocumentRecordError extends Error {
  readonly hint: string | null;
  readonly code: string | null;

  constructor(message: string, hint: string | null, code: string | null) {
    super(message);
    this.name = 'CustomerDocumentRecordError';
    this.hint = hint;
    this.code = code;
  }
}

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Record a staff upload or case build that already sits in the private
 * 'case-files' bucket, through `customer_documents_record_internal`
 * (migration 180, service role); the NAS worker later copies it into the
 * customer's folder. Idempotent on the storage pair: recording the same
 * object again returns the same document.
 *
 * Unlike `recordCustomerDocument` this is called from staff actions, so
 * it THROWS a `CustomerDocumentRecordError` instead of swallowing. Null
 * only when the call succeeded but returned no row.
 */
export async function recordCustomerDocumentInternal(
  admin: Pick<SupabaseClient, 'rpc'>,
  input: InternalCustomerDocumentInput
): Promise<{ documentId: string; ref: string } | null> {
  let reply: { data: unknown; error: unknown };
  try {
    reply = await admin.rpc('customer_documents_record_internal', {
      p_account_id: input.accountId,
      p_contact_id: input.contactId,
      p_source: input.source,
      p_kind: input.kind,
      p_storage_bucket: input.storageBucket,
      p_storage_path: input.storagePath,
      p_received_at: input.receivedAt,
      p_mime: blankToNull(input.mime ?? null),
      p_original_name: blankToNull(input.originalName ?? null),
      p_case_id: input.caseId ?? null,
      p_uploaded_by: input.source === 'staff_upload' ? input.uploadedBy : null,
    });
  } catch (err) {
    throw new CustomerDocumentRecordError(
      `customer_documents_record_internal: ${
        err instanceof Error ? err.message : String(err)
      }`,
      null,
      null
    );
  }
  const { data, error } = reply;
  if (error) {
    const e = error as { message?: unknown; hint?: unknown; code?: unknown };
    throw new CustomerDocumentRecordError(
      `customer_documents_record_internal: ${nonBlank(e.message) ?? 'failed'}`,
      nonBlank(e.hint),
      nonBlank(e.code)
    );
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    { document_id?: unknown; ref?: unknown } | null | undefined;
  const documentId = nonBlank(row?.document_id);
  const ref = nonBlank(row?.ref);
  return documentId && ref ? { documentId, ref } : null;
}
