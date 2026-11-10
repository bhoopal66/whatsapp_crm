import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  GroupCustomerDocument,
  GroupCustomerDocumentHook,
} from '@/lib/submission-groups/inbound';
import {
  mirrorInboundMedia,
  type MirrorInboundMediaArgs,
  type MirrorStorage,
} from '@/lib/whatsapp/mirror-inbound-media';

import { recordCustomerDocument } from './record';

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface GroupDocumentDeps {
  admin: Pick<SupabaseClient, 'rpc'> & { storage: MirrorStorage };
  /**
   * The Whapi channel token, read only when a document arrives (a
   * decrypt that throws is then one document's failure, not the
   * delivery's).
   */
  accessToken: () => string;
  /** Tests inject a fake; production uses the 1:1 pipeline's mirror. */
  mirror?: (args: MirrorInboundMediaArgs) => Promise<string | null>;
}

/**
 * The submission-group filing hook for the Whapi webhook. A Whapi link
 * may be the gateway's own `/media/…` endpoint, which answers only with
 * the channel token, so the NAS worker (a plain fetch) cannot use it:
 * the bytes are copied into `chat-media` first, exactly as
 * `resolveInboundMediaUrl` does for a 1:1 Whapi message (same account
 * folder, path derived from the media id), and that URL is recorded.
 * The mirror is not subject to the per-number opt-out (039) because the
 * worker has no other way to the file. No mirror, nothing recorded: one
 * log line with the row id, no URL or name.
 */
export function groupCustomerDocumentHook(
  deps: GroupDocumentDeps
): GroupCustomerDocumentHook {
  const mirror = deps.mirror ?? mirrorInboundMedia;
  return async (doc: GroupCustomerDocument) => {
    const media = doc.media;
    const link = text(media.link);
    let mirrored: string | null = null;
    try {
      if (link)
        mirrored = await mirror({
          storage: deps.admin.storage,
          accountId: doc.accountId,
          mediaId: text(media.id) ?? doc.waMessageId,
          downloadUrl: link,
          accessToken: deps.accessToken(),
          mimeType: text(media.mime_type),
          fileSize: count(media.file_size),
          fileName: text(media.filename),
          messageTimestamp: Math.floor(Date.parse(doc.sentAt) / 1000) || null,
        });
    } catch {
      // mirrorInboundMedia swallows its own failures; a throw here (the
      // token's decrypt) is treated the same way.
      mirrored = null;
    }
    if (!mirrored) {
      console.error(
        `[customer-docs] group media not mirrored for group message ${doc.groupMessageId}`
      );
      return null;
    }
    return recordCustomerDocument(deps.admin, {
      source: 'submission_group',
      accountId: doc.accountId,
      contactId: doc.contactId,
      groupMessageId: doc.groupMessageId,
      kind: doc.kind,
      mediaUrl: mirrored,
      mime: text(media.mime_type),
      originalName: text(media.filename),
      caption: doc.caption,
      receivedAt: doc.sentAt,
    });
  };
}
