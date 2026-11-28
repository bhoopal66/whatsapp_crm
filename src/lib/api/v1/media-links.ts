/**
 * Attachment and contact-picture links in public API answers (v1, and
 * the MCP server that reads it). chat-media is private since migration
 * 321, so the stored link no longer opens on its own: each of our
 * chat-media links in an answer is replaced by a signed link valid for
 * API_MEDIA_LINK_TTL_SECONDS, signed in one batch. Only objects in the
 * key's own workspace folder are signed; any other link is left as it is.
 * A failed signing leaves the stored link (it then does not open), never
 * fails the request.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { toPublicSupabaseUrl } from '@/lib/supabase/urls';
import {
  CHAT_MEDIA_BUCKET,
  chatMediaObjectPath,
} from '@/lib/storage/chat-media-url';

export const API_MEDIA_LINK_TTL_SECONDS = 60 * 60;

export async function withSignedMediaLinks<T extends object>(
  items: T[],
  fields: readonly string[],
  accountId: string,
  db: () => SupabaseClient = supabaseAdmin
): Promise<T[]> {
  const own = `account-${accountId}/`;
  const paths = new Set<string>();
  for (const item of items)
    for (const f of fields) {
      const path = chatMediaObjectPath((item as Record<string, unknown>)[f]);
      if (path?.startsWith(own)) paths.add(path);
    }
  if (paths.size === 0) return items;
  const signed = new Map<string, string>();
  try {
    const { data, error } = await db()
      .storage.from(CHAT_MEDIA_BUCKET)
      .createSignedUrls([...paths], API_MEDIA_LINK_TTL_SECONDS);
    if (!error)
      for (const d of data ?? [])
        if (d.path && d.signedUrl && !d.error)
          signed.set(d.path, toPublicSupabaseUrl(d.signedUrl));
  } catch (err) {
    console.error(
      '[api/v1] could not sign media links:',
      err instanceof Error ? err.message : err
    );
  }
  return items.map((item) => {
    let out: Record<string, unknown> | null = null;
    for (const f of fields) {
      const path = chatMediaObjectPath((item as Record<string, unknown>)[f]);
      const link = path ? signed.get(path) : undefined;
      if (link) {
        out ??= { ...(item as Record<string, unknown>) };
        out[f] = link;
      }
    }
    return (out ?? item) as T;
  });
}
