import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  WhatsAppChannel,
  WhatsAppProvider,
} from '@/lib/whatsapp/channels';
import { isMetaMediaHost } from '@/lib/whatsapp/meta-api';
import {
  mirrorInboundMedia,
  type MirrorStorage,
} from '@/lib/whatsapp/mirror-inbound-media';
import { downloadMedia, getMediaUrl } from '@/lib/whatsapp/provider';
import { isWhapiMediaHost } from '@/lib/whatsapp/whapi-api';

import { recordCustomerDocument, type CustomerDocumentInput } from './record';

/**
 * How long one filing copy may take before it gives up. The copy runs
 * inside the webhook route's `after()` (maxDuration 60) next to the rest
 * of the fan-out, so it gets a third of that and no more.
 */
export const FILING_COPY_TIMEOUT_MS = 20_000;

/** The path every public object of our `chat-media` bucket sits under. */
const OWN_STORAGE_PATH = '/storage/v1/object/public/chat-media/';

/**
 * A URL in our own `chat-media` bucket: the worker can fetch it with no
 * credentials. Matched on the path, whatever the origin, because the
 * public origin changes with the tunnel (the staged-media sweep does the
 * same).
 */
export function isOwnStorageUrl(url: string): boolean {
  try {
    return new URL(url).pathname.includes(OWN_STORAGE_PATH);
  } catch {
    return false;
  }
}

/**
 * A link the NAS worker, which holds no gateway credentials, can still
 * download: https, and not a gateway media host. A Meta lookaside URL
 * needs the bearer token and expires in minutes; a Whapi `/media/` link
 * needs the channel token; an OpenWA link is a loopback endpoint behind
 * an API key, whatever its shape. What is left is a public link such as
 * the storage URL Whapi's auto-download hands out.
 */
export function isCredentialFreeLink(
  url: string,
  provider: WhatsAppProvider
): boolean {
  if (provider === 'openwa') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return !isMetaMediaHost(parsed) && !isWhapiMediaHost(parsed);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** The record input, less the URL: the copy decides which URL to file. */
export type FilingRecordInput = DistributiveOmit<
  CustomerDocumentInput,
  'mediaUrl'
>;

/** The inbound attachment, as the gateway described it. */
export interface FilingMedia {
  /** The gateway's download link, if the payload (or a lookup) had one. */
  link: string | null;
  /** The gateway's media id, resolved through `getMediaUrl` when `link` is null. */
  id: string | null;
  /** The mirror's deterministic object id (the media id, else the message id). */
  objectId: string;
  mimeType: string | null;
  fileSize: number | null;
  fileName: string | null;
  /** Message timestamp, epoch seconds. */
  messageTimestamp: string | number | null;
}

export interface FilingCopyDeps {
  mirror: typeof mirrorInboundMedia;
  getMediaUrl: typeof getMediaUrl;
  download: typeof downloadMedia;
  timeoutMs: number;
}

const DEFAULT_DEPS: FilingCopyDeps = {
  mirror: mirrorInboundMedia,
  getMediaUrl,
  download: downloadMedia,
  timeoutMs: FILING_COPY_TIMEOUT_MS,
};

function recordLabel(record: FilingRecordInput): string {
  return record.source === 'submission_group'
    ? `group message ${record.groupMessageId}`
    : `message ${record.messageRowId}`;
}

/**
 * File a customer document whose stored URL the NAS worker could not
 * fetch: copy the bytes into our own bucket first, exactly as the
 * inbound mirror does (same storage, account folder, deterministic
 * object id and gateway credentials), then record the copy's URL.
 *
 * Without a copy it records the gateway link only when that link needs
 * no credentials; otherwise it records nothing and logs one line naming
 * the message (ids only), because a record of a URL the worker can never
 * download is a document that only looks filed.
 *
 * The channel is a thunk so a caller that has not loaded one yet (the
 * group path) pays for it only here. Never throws, and a copy that lost
 * the race with the timeout but is still running can never reject
 * unhandled: the caller awaits this inside the route's `after()`.
 */
export async function fileWithDurableCopy(args: {
  admin: Pick<SupabaseClient, 'rpc'> & { storage: MirrorStorage };
  channel: () => WhatsAppChannel;
  media: FilingMedia;
  record: FilingRecordInput;
  deps?: Partial<FilingCopyDeps>;
}): Promise<void> {
  const { admin, media, record } = args;
  const deps: FilingCopyDeps = { ...DEFAULT_DEPS, ...args.deps };
  const label = recordLabel(record);

  try {
    const channel = args.channel();
    let link = media.link;
    let mimeType = media.mimeType;
    let fileSize = media.fileSize;

    const copy = (async (): Promise<string | null> => {
      if (!link) {
        if (!media.id) return null;
        const info = await deps.getMediaUrl({ channel, mediaId: media.id });
        link = info.url;
        mimeType = mimeType ?? info.mimeType;
        fileSize = fileSize ?? info.fileSize;
      }
      return deps.mirror({
        storage: admin.storage,
        accountId: channel.accountId,
        mediaId: media.objectId,
        downloadUrl: link,
        accessToken: channel.accessToken,
        download: ({ downloadUrl }) => deps.download({ channel, downloadUrl }),
        mimeType: mimeType ?? undefined,
        fileSize,
        fileName: media.fileName,
        messageTimestamp: media.messageTimestamp,
      });
      // Swallowed here, before the race, so a copy still running after
      // the timeout has nobody left to reject to.
    })().catch(() => null);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deps.timeoutMs);
    });
    let mirrored: string | null;
    try {
      mirrored = await Promise.race([copy, timedOut]);
    } finally {
      clearTimeout(timer);
    }

    let mediaUrl: string | null = null;
    if (mirrored) mediaUrl = mirrored;
    else if (link && isCredentialFreeLink(link, channel.provider)) {
      mediaUrl = link;
    }

    if (!mediaUrl) {
      console.error(`[customer-docs] no durable copy for ${label}`);
      return;
    }
    await recordCustomerDocument(admin, {
      ...record,
      mediaUrl,
    } as CustomerDocumentInput);
  } catch (err) {
    // The error's name only: a gateway or fetch message can carry a URL.
    console.error(
      `[customer-docs] filing failed for ${label}: ${
        err instanceof Error ? err.name : typeof err
      }`
    );
  }
}
