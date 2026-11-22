/**
 * Pure parts of POST /api/contacts/bulk/chat-tag: the request body and
 * the per-contact tally the route answers with.
 */

export const BULK_CHAT_TAG_MAX_CONTACTS = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BulkChatTagRequest {
  contactIds: string[];
  chatTagId: string | null;
  /** undefined = keep a sub-tag while the main tag is unchanged. */
  subTagId: string | null | undefined;
}

export type ParsedBulkChatTag =
  { ok: true; value: BulkChatTagRequest } | { ok: false; error: string };

export function parseBulkChatTagBody(body: unknown): ParsedBulkChatTag {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'A JSON body is required' };
  }
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.contactIds) || b.contactIds.length === 0) {
    return { ok: false, error: 'contactIds must be a non-empty array' };
  }
  if (b.contactIds.length > BULK_CHAT_TAG_MAX_CONTACTS) {
    return {
      ok: false,
      error: `At most ${BULK_CHAT_TAG_MAX_CONTACTS} contacts at a time`,
    };
  }
  if (!b.contactIds.every((id) => typeof id === 'string' && UUID.test(id))) {
    return { ok: false, error: 'contactIds must be contact ids' };
  }
  const contactIds = [...new Set(b.contactIds as string[])];
  const tag = b.chatTagId;
  if (tag !== null && !(typeof tag === 'string' && UUID.test(tag))) {
    return { ok: false, error: 'chatTagId must be a tag id or null' };
  }
  const sub = b.subTagId;
  if (
    sub !== undefined &&
    sub !== null &&
    !(typeof sub === 'string' && UUID.test(sub))
  ) {
    return { ok: false, error: 'subTagId must be a tag id or null' };
  }
  if (typeof sub === 'string' && tag === null) {
    return { ok: false, error: 'A sub-tag needs a main tag' };
  }
  return {
    ok: true,
    value: { contactIds, chatTagId: tag as string | null, subTagId: sub },
  };
}

export type BulkOutcome = 'updated' | 'unchanged' | 'skipped' | 'failed';

export interface BulkChatTagCounts {
  updated: number;
  unchanged: number;
  /** No chat for the contact, or the caller may not change its tags. */
  skipped: number;
  /** The database refused the tag pairing, or the write errored. */
  failed: number;
}

export function tallyBulkOutcomes(
  outcomes: readonly BulkOutcome[]
): BulkChatTagCounts {
  const counts: BulkChatTagCounts = {
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
  };
  for (const o of outcomes) counts[o] += 1;
  return counts;
}
