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
import { isGatewayFetchable } from '@/lib/whatsapp/forward';

/** Our auth-gated media proxy — see `lib/media/blob-cache.ts`. */
const PROXY_PREFIX = '/api/whatsapp/media/';

export interface ForwardMediaArgs {
  accountId: string;
  /** The source row's id — makes the re-hosted object path stable. */
  sourceMessageId: string;
  mediaUrl: string;
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
 * Return a URL any gateway can fetch, re-hosting into the `chat-media`
 * bucket when the stored one is not. Null when the bytes could not be
 * obtained (expired at the gateway, too large for the bucket, a MIME the
 * bucket refuses) — the caller reports the forward as failed.
 *
 * Re-hosting goes through `mirrorInboundMedia`, which is exactly "fetch
 * gateway bytes with a token, store them in our bucket, hand back the
 * public URL". It keys the object on `fwd-<source id>`, so forwarding the
 * same attachment again rewrites one object rather than piling up copies.
 */
export async function resolveForwardMediaUrl(
  args: ForwardMediaArgs
): Promise<string | null> {
  const {
    accountId,
    sourceMessageId,
    mediaUrl,
    mimeType,
    filename,
    channel,
    mirror = mirrorInboundMedia,
  } = args;

  if (isGatewayFetchable(mediaUrl, publicSupabaseUrl())) return mediaUrl;

  let downloadUrl = mediaUrl;
  if (mediaUrl.startsWith(PROXY_PREFIX)) {
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
      return null;
    }
  }

  return mirror({
    storage: supabaseAdmin().storage,
    accountId,
    mediaId: `fwd-${sourceMessageId}`,
    downloadUrl,
    accessToken: channel.accessToken,
    mimeType,
    fileName: filename,
    // The mirror's default downloader is Whapi's; route the download
    // through whichever gateway actually holds the bytes.
    download: ({ downloadUrl: url }) =>
      downloadMedia({ channel, downloadUrl: url }),
  });
}
