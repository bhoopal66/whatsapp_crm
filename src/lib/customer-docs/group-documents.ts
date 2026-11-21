import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  GroupCustomerDocument,
  GroupCustomerDocumentHook,
} from '@/lib/submission-groups/inbound';
import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import type { MirrorStorage } from '@/lib/whatsapp/mirror-inbound-media';

import { fileWithDurableCopy, type FilingCopyDeps } from './filing-copy';

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface GroupDocumentFilerDeps {
  admin: Pick<SupabaseClient, 'rpc'> & { storage: MirrorStorage };
  /**
   * The number the group lives on, built only when a document is filed
   * (a decrypt that throws is then one document's failure, not the
   * delivery's).
   */
  channel: () => WhatsAppChannel;
  /** Tests inject fakes; production uses the 1:1 pipeline's mirror. */
  deps?: Partial<FilingCopyDeps>;
}

export interface GroupDocumentFiler {
  /** Collects one document; no I/O, never throws. */
  hook: GroupCustomerDocumentHook;
  /** Files every collected document, one at a time; never throws. */
  run: () => Promise<void>;
}

/**
 * The submission-group filing for the Whapi webhook, in two halves. The
 * group loop only collects (`hook`), because the copy downloads from the
 * gateway and uploads to storage: done inside the loop, a slow gateway
 * held every 1:1 message of the delivery behind it and could push them
 * past the route's 60 s `after()` budget. The route calls `run` after
 * the 1:1 messages, in a `finally`, so a failure there still files.
 *
 * Each document goes through `fileWithDurableCopy`, like the 1:1 path:
 * a payload with a media id and no link is resolved through
 * `getMediaUrl`, the bytes are copied into `chat-media` (same account
 * folder, object id = the media id, else the message id) within the
 * copy timeout, and that URL is recorded; a Whapi `/media/` link is
 * never recorded, because the NAS worker holds no token. The mirror is
 * not subject to the per-number opt-out (039): the worker has no other
 * way to the file.
 */
export function groupDocumentFiler(
  args: GroupDocumentFilerDeps
): GroupDocumentFiler {
  const queue: GroupCustomerDocument[] = [];
  return {
    hook: (doc) => {
      queue.push(doc);
    },
    run: async () => {
      for (const doc of queue.splice(0)) {
        // fileWithDurableCopy never throws; the guard keeps one bad
        // payload from stopping the rest all the same.
        try {
          await fileOne(args, doc);
        } catch {
          console.error(
            `[customer-docs] filing failed for group message ${doc.groupMessageId}`
          );
        }
      }
    },
  };
}

function fileOne(
  args: GroupDocumentFilerDeps,
  doc: GroupCustomerDocument
): Promise<void> {
  const media = doc.media;
  const mediaId = text(media.id);
  return fileWithDurableCopy({
    admin: args.admin,
    channel: args.channel,
    media: {
      link: text(media.link),
      id: mediaId,
      objectId: mediaId ?? doc.waMessageId,
      mimeType: text(media.mime_type),
      fileSize: count(media.file_size),
      fileName: text(media.filename),
      messageTimestamp: Math.floor(Date.parse(doc.sentAt) / 1000) || null,
    },
    record: {
      source: 'submission_group',
      accountId: doc.accountId,
      contactId: doc.contactId,
      groupMessageId: doc.groupMessageId,
      kind: doc.kind,
      mime: text(media.mime_type),
      originalName: text(media.filename),
      caption: doc.caption,
      receivedAt: doc.sentAt,
    },
    deps: args.deps,
  }).then(() => undefined);
}
