// After a membership change, re-read the group from Whapi and store the
// snapshot. Best effort: the change itself already happened, so a
// failure here is logged and reported as `resynced: false`, never an
// error to the caller.

import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import { getGroup } from '@/lib/whatsapp/groups';

import { persistGroupSnapshot, supabaseAdmin } from './server';

export async function resyncGroup(
  channel: WhatsAppChannel,
  waGroupId: string
): Promise<boolean> {
  try {
    const fresh = await getGroup({ channel, groupId: waGroupId });
    await persistGroupSnapshot(supabaseAdmin(), channel, fresh);
    return true;
  } catch (err) {
    console.error('[groups] resync after change failed', err);
    return false;
  }
}
