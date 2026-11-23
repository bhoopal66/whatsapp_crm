/**
 * The durable copy of a file somebody sent in a WhatsApp group.
 *
 * A group message is stored as the gateway described it: Whapi's own link
 * stops working after about 30 days, and OpenWA has no link a browser can
 * load at all. After the row is stored, the bytes go through the one-to-one
 * chats' mirror (same bucket, same `inbound/` folder, same object key and
 * size and type limits), and the row's `media.link` becomes ours.
 *
 * Best effort, and never throws: a failed copy leaves the row as it was and
 * logs ids only. Run twice it copies once, because the row's link is then
 * ours. The write is a compare-and-set on the gateway id and link that were
 * read, so a row our send route, an erase or a retention job has written
 * meanwhile keeps what they wrote.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import { resolveInboundMediaUrl } from '@/lib/whatsapp/inbound-pipeline';

import type { GroupInboundMessage } from './inbound';
import { chatMediaPathOf } from './outbound-media';

const COPIED_TYPES: readonly string[] = [
  'image',
  'sticker',
  'video',
  'audio',
  'document',
];

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Whether a link names an object of this account in our own bucket. */
function isOurs(link: string, accountId: string): boolean {
  return chatMediaPathOf(link)?.startsWith(`account-${accountId}/`) ?? false;
}

/** Whether a message carries a file the gateway can still hand over. */
export function hasGroupFile(message: GroupInboundMessage): boolean {
  return (
    COPIED_TYPES.includes(message.type) &&
    (text(message.media?.id) ?? text(message.media?.link)) !== null
  );
}

export async function copyGroupMessageMedia(
  admin: SupabaseClient,
  /** The number the group lives on; a thunk because it decrypts. */
  loadChannel: () => WhatsAppChannel,
  message: GroupInboundMessage
): Promise<void> {
  if (!hasGroupFile(message)) return;
  let rowId: string | null = null;
  try {
    const channel = loadChannel();
    // 039's opt-out, as for one-to-one chats: an OpenWA number is always
    // copied, since its gateway has no link to fall back on.
    if (channel.provider !== 'openwa' && !channel.mirrorInboundMedia) return;

    // Two numbers of an account can sit in one WhatsApp group; each has its
    // own group row, so the message is looked up under this number's.
    const group = await admin
      .from('whatsapp_groups')
      .select('id')
      .eq('account_id', channel.accountId)
      .eq('channel_id', channel.id)
      .eq('wa_group_id', message.waGroupId)
      .maybeSingle();
    if (group.error) throw group.error;
    if (!group.data) return;
    const found = await admin
      .from('whatsapp_group_messages')
      .select('id, media')
      .eq('account_id', channel.accountId)
      .eq('group_id', group.data.id)
      .eq('wa_message_id', message.id)
      .maybeSingle();
    if (found.error) throw found.error;
    const row = found.data as {
      id: string;
      media: Record<string, unknown> | null;
    } | null;
    // No media any more (erased), or another file than this message's: our
    // own send, whose row already carries the upload.
    if (!row?.media) return;
    const id = text(row.media.id);
    const link = text(row.media.link);
    if (id !== text(message.media?.id)) return;
    if (link && isOurs(link, channel.accountId)) return;
    rowId = row.id;

    const size = row.media.file_size;
    const url = await resolveInboundMediaUrl(
      {
        id: message.id,
        timestamp: String(Math.floor(Date.parse(message.sentAt) / 1000)),
        media: {
          id,
          link,
          mimeType: text(row.media.mime_type),
          filename: text(row.media.filename),
          fileSize: typeof size === 'number' ? size : null,
        },
      },
      channel,
      { accountId: channel.accountId }
    );
    if (!url || !isOurs(url, channel.accountId)) {
      console.warn(`[groups-webhook] no durable copy for message ${rowId}`);
      return;
    }

    let update = admin
      .from('whatsapp_group_messages')
      .update({ media: { ...row.media, link: url } })
      .eq('id', row.id);
    update = id ? update.eq('media->>id', id) : update.is('media->>id', null);
    update = link
      ? update.eq('media->>link', link)
      : update.is('media->>link', null);
    const { error } = await update;
    if (error) throw error;
  } catch (error) {
    // The code or class only: a message can quote a number or a link.
    const e = error as { code?: unknown; name?: unknown } | null;
    console.warn(
      `[groups-webhook] media copy failed for message ${rowId ?? 'unread'}: ${
        text(e?.code) ?? text(e?.name) ?? 'unknown error'
      }`
    );
  }
}
