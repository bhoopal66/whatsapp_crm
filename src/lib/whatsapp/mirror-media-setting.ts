// The media-keeping switch of one WhatsApp number (Settings → numbers).
//
// The write asks for the changed row back (`updateRow`): with the number
// gone or the right to change it withdrawn, RLS filters the update to
// nothing and PostgREST answers success, which the panel would show as
// a saved switch.

import { updateRow, type RowWriter } from '@/lib/supabase/changed-rows';

/** The update matched no row: the number or the right to change it went. */
export class MirrorNotSavedError extends Error {}

/** Throws when the switch was not saved; the caller puts it back. */
export async function saveMirrorInboundMedia(
  sb: RowWriter,
  configId: string,
  next: boolean
): Promise<void> {
  const res = await updateRow(sb, 'whatsapp_config', configId, {
    mirror_inbound_media: next,
  });
  if (res.kind === 'failed') throw new Error(res.error.message);
  if (res.kind === 'none') throw new MirrorNotSavedError();
}
