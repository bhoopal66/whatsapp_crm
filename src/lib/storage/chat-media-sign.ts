/**
 * Short-lived signed links to private `chat-media` objects (migration
 * 321), for the two kinds of reader that are not a person in the app:
 *
 *   - a WhatsApp gateway (Meta, Whapi, OpenWA) that downloads an
 *     attachment we send: `gatewayMediaLink()` swaps our stored link for
 *     a signed one at the moment of sending (lib/whatsapp/provider.ts and
 *     lib/whatsapp/groups.ts call it);
 *   - the app's own media route, which redirects a checked caller to a
 *     signed link (src/app/api/media/chat/[...path]/route.ts).
 *
 * A signed link names the object and expires; nothing else opens it. It
 * is built on the public Supabase origin (toPublicSupabaseUrl), the one a
 * gateway can reach. Server-only (service role). Never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { toPublicSupabaseUrl } from '@/lib/supabase/urls';

import { CHAT_MEDIA_BUCKET, chatMediaObjectPath } from './chat-media-url';

/** Long enough for a gateway to fetch the file, even a slow one retrying. */
export const GATEWAY_LINK_TTL_SECONDS = 6 * 60 * 60;
/** A person's browser follows the redirect at once; a reload signs again. */
export const VIEWER_LINK_TTL_SECONDS = 5 * 60;

export async function signChatMediaPath(
  path: string,
  ttlSeconds: number,
  db: () => SupabaseClient = supabaseAdmin,
  /** Served as an attachment under this name (a download button). */
  download?: string
): Promise<string | null> {
  try {
    const { data, error } = await db()
      .storage.from(CHAT_MEDIA_BUCKET)
      .createSignedUrl(path, ttlSeconds, download ? { download } : undefined);
    if (error || !data?.signedUrl) return null;
    return toPublicSupabaseUrl(data.signedUrl);
  } catch {
    return null;
  }
}

/**
 * The link a gateway is given for an attachment: a signed link when it is
 * one of our chat-media objects, the link itself otherwise (a Meta media
 * URL, a flow's own file, an operator's https link). If signing fails the
 * stored link is kept: before 321 is applied it still opens, after it the
 * gateway's refusal is the send failure the person sees, never a silent
 * one.
 */
export async function gatewayMediaLink(
  link: string,
  db: () => SupabaseClient = supabaseAdmin
): Promise<string> {
  const path = chatMediaObjectPath(link);
  if (!path) return link;
  const signed = await signChatMediaPath(path, GATEWAY_LINK_TTL_SECONDS, db);
  if (!signed) {
    console.error(
      '[chat-media] could not sign a gateway link; sending the stored one'
    );
    return link;
  }
  return signed;
}
