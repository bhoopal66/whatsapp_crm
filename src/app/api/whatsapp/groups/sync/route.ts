// ============================================================
// POST /api/whatsapp/groups/sync — pull every Whapi number's groups in
// from WhatsApp (admin and up). A group no longer listed is marked
// `left`, but only when that number's listing was complete: a capped or
// interrupted walk proves nothing about the groups it did not reach.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { canSyncGroups } from '@/lib/groups/access';
import {
  GroupHttpError,
  groupErrorResponse,
  persistGroupSnapshot,
  supabaseAdmin,
} from '@/lib/groups/server';
import { loadChannels } from '@/lib/whatsapp/channels';
import { listGroups } from '@/lib/whatsapp/groups';

export const maxDuration = 60;

/** Groups read per number; one more is asked for to detect a cut. */
export const SYNC_GROUPS_PER_CHANNEL = 300;
/** No new number is started after this; persisting stops at the hard stop. */
const START_BUDGET_MS = 45_000;
const HARD_STOP_MS = 52_000;

export async function POST() {
  try {
    const ctx = await getCurrentAccount();
    if (!canSyncGroups(ctx.role)) {
      throw new GroupHttpError(
        403,
        'not_allowed',
        'Only an admin can sync groups'
      );
    }
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    const admin = supabaseAdmin();
    // loadChannels skips a number whose token will not decrypt.
    const channels = (await loadChannels(admin, ctx.accountId)).filter(
      (c) => c.provider === 'whapi' && c.status !== 'disconnected'
    );

    let synced = 0;
    let created = 0;
    let left = 0;
    let truncated = false;
    let done = 0;
    let firstFailure: unknown = null;

    for (const channel of channels) {
      if (elapsed() > START_BUDGET_MS) {
        truncated = true;
        break;
      }
      const existing = await admin
        .from('whatsapp_groups')
        .select('id, wa_group_id, our_role')
        .eq('account_id', ctx.accountId)
        .eq('channel_id', channel.id);
      if (existing.error) throw existing.error;
      const known = (existing.data ?? []) as Array<{
        id: string;
        wa_group_id: string;
        our_role: string;
      }>;
      const knownIds = new Set(known.map((g) => g.wa_group_id));

      let listed;
      try {
        listed = await listGroups({
          channel,
          maxGroups: SYNC_GROUPS_PER_CHANNEL + 1,
        });
      } catch (err) {
        // One number down must not stop the others.
        console.error('[groups] sync listing failed', channel.id, err);
        firstFailure ??= err;
        continue;
      }
      done++;
      let complete = listed.length <= SYNC_GROUPS_PER_CHANNEL;
      const seen = new Set<string>();
      for (const group of listed.slice(0, SYNC_GROUPS_PER_CHANNEL)) {
        if (elapsed() > HARD_STOP_MS) {
          complete = false;
          break;
        }
        seen.add(group.id);
        try {
          await persistGroupSnapshot(admin, channel, group);
          synced++;
          if (!knownIds.has(group.id)) created++;
        } catch (err) {
          console.error('[groups] sync persist failed', group.id, err);
        }
      }
      if (!complete) {
        truncated = true;
        continue;
      }
      const gone = known
        .filter((g) => g.our_role !== 'left' && !seen.has(g.wa_group_id))
        .map((g) => g.id);
      if (gone.length > 0) {
        const upd = await admin
          .from('whatsapp_groups')
          .update({ our_role: 'left' })
          .eq('account_id', ctx.accountId)
          .in('id', gone);
        if (upd.error) console.error('[groups] mark left failed', upd.error);
        else left += gone.length;
      }
    }

    if (done === 0 && firstFailure) throw firstFailure;
    return NextResponse.json({
      synced,
      created,
      left,
      truncated,
      channels: done,
    });
  } catch (err) {
    return groupErrorResponse(err);
  }
}
