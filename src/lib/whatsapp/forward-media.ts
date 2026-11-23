// ============================================================
// Make a message's attachment fetchable by a gateway, so it can be
// forwarded. Server-only; the pure half is `forward.ts`.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { publicSupabaseUrl } from '@/lib/supabase/urls';
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/provider';
import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import {
  mirrorInboundMedia,
  type MirrorInboundMediaArgs,
} from '@/lib/whatsapp/mirror-inbound-media';
import { ownPublicMediaUrl } from '@/lib/whatsapp/forward';
import { isMetaMediaHost } from '@/lib/whatsapp/meta-api';
import { isOpenWAMediaUrl } from '@/lib/whatsapp/openwa-api';
import {
  isWhapiFileStoreUrl,
  isWhapiMediaHost,
} from '@/lib/whatsapp/whapi-api';

/** Our auth-gated media proxy — see `lib/media/blob-cache.ts`. */
const PROXY_PREFIX = '/api/whatsapp/media/';

export interface ForwardMediaArgs {
  accountId: string;
  /** The source row's id — makes the re-hosted object path stable. */
  sourceMessageId: string;
  mediaUrl: string;
  /** Whether a customer sent the source: only then is a proxy path ours. */
  fromCustomer: boolean;
  mimeType?: string | null;
  /** Filename to keep on a re-hosted document. */
  filename?: string | null;
  /**
   * The channel the source message arrived on. Its token is what the
   * gateway-hosted bytes are behind.
   */
  channel: WhatsAppChannel;
  /** Injected in tests. */
  mirror?: (args: MirrorInboundMediaArgs) => Promise<string | null>;
}

/**
 * `refused`: the row names a place attachments do not live in.
 * `unavailable`: the bytes could not be obtained (expired at the gateway,
 * too large for the bucket).
 */
export type ForwardMediaResult =
  { ok: true; url: string } | { ok: false; reason: 'refused' | 'unavailable' };

/**
 * True for a media URL of the gateway of the number that carried the
 * message: what an inbound row holds when the mirror is off or failed.
 */
function isChannelMediaUrl(raw: string, channel: WhatsAppChannel): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  switch (channel.provider) {
    case 'whapi':
      return isWhapiMediaHost(url) || isWhapiFileStoreUrl(url);
    case 'meta':
      return isMetaMediaHost(url);
    case 'openwa':
      return isOpenWAMediaUrl(url, channel.phoneNumberId);
    default: {
      const unknown: never = channel.provider;
      void unknown;
      return false;
    }
  }
}

/**
 * A URL any gateway can fetch, re-hosting into the `chat-media` bucket
 * when the stored one is not.
 *
 * The server fetches what the row names and publishes it, so a row may
 * only name our own storage, our proxy (on a customer's message, as in
 * the proxy's own check) or the carrying number's gateway.
 *
 * Re-hosting goes through `mirrorInboundMedia`, which is exactly "fetch
 * gateway bytes with a token, store them in our bucket, hand back the
 * public URL". It keys the object on `fwd-<source id>`, so forwarding the
 * same attachment again rewrites one object rather than piling up copies.
 */
export async function resolveForwardMediaUrl(
  args: ForwardMediaArgs
): Promise<ForwardMediaResult> {
  const {
    accountId,
    sourceMessageId,
    mediaUrl,
    fromCustomer,
    mimeType,
    filename,
    channel,
    mirror = mirrorInboundMedia,
  } = args;

  const own = ownPublicMediaUrl(mediaUrl, publicSupabaseUrl(), accountId);
  if (own) return { ok: true, url: own };

  let downloadUrl = mediaUrl;
  const proxied = mediaUrl.startsWith(PROXY_PREFIX);
  if (proxied ? !fromCustomer : !isChannelMediaUrl(mediaUrl, channel)) {
    return { ok: false, reason: 'refused' };
  }
  if (proxied) {
    const mediaId = decodeURIComponent(
      mediaUrl.slice(PROXY_PREFIX.length).split(/[?#]/)[0]
    );
    try {
      downloadUrl = (await getMediaUrl({ channel, mediaId })).url;
    } catch (err) {
      console.warn(
        `[forward] could not resolve media ${mediaId}:`,
        err instanceof Error ? err.message : err
      );
      return { ok: false, reason: 'unavailable' };
    }
  }

  const url = await mirror({
    storage: supabaseAdmin().storage,
    accountId,
    mediaId: `fwd-${sourceMessageId}`,
    downloadUrl,
    accessToken: channel.accessToken,
    mimeType,
    fileName: filename,
    // The mirror's default downloader is Whapi's; route the download
    // through whichever gateway actually holds the bytes.
    download: ({ downloadUrl: url, maxBytes }) =>
      downloadMedia({ channel, downloadUrl: url, maxBytes }),
  });
  return url ? { ok: true, url } : { ok: false, reason: 'unavailable' };
}
