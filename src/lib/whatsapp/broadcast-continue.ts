// ============================================================
// Whether the cron may continue a scheduled campaign whose last pass
// ended with recipients still pending.
//
// A pass that stopped early wrote the reason on the recipient it stopped
// at, which stays pending. That text decides what has to be true before
// another pass is worth starting. No reason at all: the pass was capped
// at 1,000, or the process restarted.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { RESENDABLE_FILTER } from '@/lib/broadcasts/unconfirmed-send';
import {
  CAMPAIGN_DAILY_LIMIT_PREFIX,
  checkAutoStartAllowed,
  companyConversationId,
} from '@/lib/team-activity/auto-guard';
import { QUIET_HOURS_STOP_PREFIX } from '@/lib/whatsapp/broadcast-core';
import {
  ChannelError,
  isLinkedDeviceProvider,
  resolveChannelForSurface,
  type WhatsAppChannel,
} from '@/lib/whatsapp/channels';

/** How long a campaign a stop left alone rests before the next try. */
export const CONTINUE_BACKOFF_MS = 30 * 60 * 1000;

export interface ContinueCandidate {
  id: string;
  account_id: string;
  /** Bumped by a trigger on every write to the campaign, its lock included. */
  updated_at: string;
}

/**
 * The caller has already checked quiet hours. Throws when the numbers
 * cannot be read; the caller skips the campaign this tick.
 */
export async function mayContinueBroadcast(
  admin: SupabaseClient,
  broadcast: ContinueCandidate,
  now: Date
): Promise<boolean> {
  const { data, error } = await admin
    .from('broadcast_recipients')
    .select('contact_id, error_message')
    .eq('broadcast_id', broadcast.id)
    .eq('status', 'pending')
    .not('error_message', 'is', null)
    // A send a restart caught half way is not a stop; planning fails it.
    .or(RESENDABLE_FILTER)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1);
  if (error) {
    console.error('[broadcast-continue] stop read failed:', error.message);
    return false;
  }
  const stop = (data ?? [])[0] as
    { contact_id: string | null; error_message: string } | undefined;
  if (!stop || stop.error_message.startsWith(QUIET_HOURS_STOP_PREFIX)) {
    return true;
  }

  if (
    now.getTime() - new Date(broadcast.updated_at).getTime() <
    CONTINUE_BACKOFF_MS
  ) {
    return false;
  }

  let channel: WhatsAppChannel;
  try {
    channel = await resolveChannelForSurface(
      admin,
      broadcast.account_id,
      'broadcast'
    );
  } catch (err) {
    // No number to send from: planning refuses and records why.
    if (err instanceof ChannelError && err.code !== 'channel_lookup_failed') {
      return true;
    }
    throw err;
  }
  if (!stop.error_message.startsWith(CAMPAIGN_DAILY_LIMIT_PREFIX)) {
    // The number itself failed. Meta's status says nothing about its
    // token, so a Meta number is simply tried again after the rest.
    return (
      !isLinkedDeviceProvider(channel.provider) ||
      channel.status === 'connected'
    );
  }

  const check = await checkAutoStartAllowed(
    admin,
    broadcast.account_id,
    stop.contact_id
      ? await companyConversationId(
          admin,
          broadcast.account_id,
          stop.contact_id
        )
      : null,
    channel
  );
  if (!check.blocked) return true;
  // Every refusal is recorded in Team activity, so asking is not free:
  // any write to the campaign restarts its rest.
  await admin
    .from('broadcasts')
    .update({ updated_at: now.toISOString() })
    .eq('id', broadcast.id);
  return false;
}

/**
 * Planning refused (a template deleted since, no number connected): say
 * so on the first pending recipient, like a stopped pass, so the campaign
 * page shows why and the next try waits its turn.
 */
export async function recordContinueRefusal(
  admin: SupabaseClient,
  broadcastId: string,
  reason: string
): Promise<void> {
  const { data } = await admin
    .from('broadcast_recipients')
    .select('id')
    .eq('broadcast_id', broadcastId)
    .eq('status', 'pending')
    .or(RESENDABLE_FILTER)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1);
  const first = (data ?? [])[0] as { id: string } | undefined;
  if (!first) return;
  await admin
    .from('broadcast_recipients')
    .update({ error_message: reason })
    .eq('id', first.id)
    .eq('status', 'pending')
    .or(RESENDABLE_FILTER);
}

/**
 * Meta refused the campaign's template (`template_refused`): no later try
 * ends differently, so the campaign is failed instead of coming due again,
 * with the reason on its first pending recipient. The rest stay pending:
 * Resume works once the template is accepted. Never touches a draft or a
 * campaign that has already ended.
 */
export async function failRefusedCampaign(
  admin: SupabaseClient,
  broadcastId: string,
  reason: string
): Promise<void> {
  await recordContinueRefusal(admin, broadcastId, reason);
  const { error } = await admin
    .from('broadcasts')
    .update({ status: 'failed', updated_at: new Date().toISOString() })
    .eq('id', broadcastId)
    .in('status', ['sending', 'scheduled']);
  if (error) {
    console.error('[broadcast-continue] refusal not recorded:', error.message);
  }
}
