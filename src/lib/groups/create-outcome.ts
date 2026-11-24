// What a group create that did not answer means. A lost answer is not a
// refusal: the group may exist, with the customers already in it, so the
// same name is not created again without asking, and a group that turns
// out to exist is given to the person who made it.

import type { SupabaseClient } from '@supabase/supabase-js';

import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import {
  findGroupsNamed,
  getGroup,
  GroupCreateUnsupportedError,
  GroupsUnsupportedError,
} from '@/lib/whatsapp/groups';
import { OpenWAGroupUnsupportedError } from '@/lib/whatsapp/openwa-groups';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { isDefiniteSendRefusal } from '@/lib/whatsapp/provider';

import { GroupHttpError, persistGroupSnapshot } from './server';
import { submissionGroupIds } from './submission-ids';

/** True only when the failed create certainly made no group. */
export function isDefiniteCreateRefusal(err: unknown): boolean {
  return (
    isDefiniteSendRefusal(err) ||
    err instanceof GroupsUnsupportedError ||
    err instanceof GroupCreateUnsupportedError ||
    err instanceof OpenWAGroupUnsupportedError
  );
}

export const createUnconfirmed = () =>
  new GroupHttpError(
    502,
    'create_unconfirmed',
    'The group may have been created. Check Groups in a minute before trying again.'
  );

export const createRepeat = () =>
  new GroupHttpError(
    409,
    'create_repeat',
    'You created a group with this name a few minutes ago. Create another?'
  );

/** One create per person, number and name; anything more is asked about. */
export const CREATE_REPEAT_RULE = { limit: 1, windowMs: 5 * 60_000 };

export function createRepeatKey(
  userId: string,
  channelId: string,
  name: string
): string {
  const normalised = name
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return `group-create-same:${userId}:${channelId}:${normalised}`;
}

/** Writes the group's manager rows; returns the error, if any. */
export async function saveGroupManagers(
  admin: SupabaseClient,
  accountId: string,
  groupId: string,
  userIds: string[]
) {
  const { error } = await admin.from('whatsapp_group_managers').upsert(
    userIds.map((user_id) => ({
      group_id: groupId,
      account_id: accountId,
      user_id,
    })),
    { onConflict: 'group_id,user_id', ignoreDuplicates: true }
  );
  return error;
}

const LOOKUP_BUDGET_MS = 20_000;
const LOOKUP_CALL_TIMEOUT_MS = 10_000;

/**
 * After an unconfirmed create: when the number holds exactly one group of
 * this name made by it since the attempt started, nobody's yet and not a
 * submission group, store it as the caller's, with the managers they
 * chose. Anything else is left for Sync. Whapi only; never throws.
 */
export async function claimUnconfirmedGroup(
  admin: SupabaseClient,
  args: {
    channel: WhatsAppChannel;
    name: string;
    startedAt: number;
    createdBy: string;
    managerIds: string[];
  }
): Promise<void> {
  const { channel } = args;
  if (channel.provider !== 'whapi') return;
  try {
    const call = { channel, timeoutMs: LOOKUP_CALL_TIMEOUT_MS };
    const named = await findGroupsNamed({
      ...call,
      name: args.name,
      deadline: Date.now() + LOOKUP_BUDGET_MS,
    });
    // WhatsApp's creation time is in whole seconds.
    const since = Math.floor(args.startedAt / 1000);
    const ours = normalizePhone(channel.wabaId ?? '') || null;
    const made = named.filter((g) => {
      const creator = g.createdBy?.waId ?? null;
      if (ours && creator && creator !== ours) return false;
      return g.createdAt !== null && g.createdAt >= since;
    });
    if (made.length !== 1) return;
    const [match] = made;

    const { data: stored, error } = await admin
      .from('whatsapp_groups')
      .select('created_by')
      .eq('account_id', channel.accountId)
      .eq('channel_id', channel.id)
      .eq('wa_group_id', match.id)
      .maybeSingle();
    if (error) throw error;
    if ((stored as { created_by: string | null } | null)?.created_by) return;
    const submission = await submissionGroupIds(admin, channel.accountId, [
      match.id,
    ]);
    if (submission.has(match.id)) return;

    // The list may leave members out, and with them our own role.
    const full = await getGroup({ ...call, groupId: match.id }).catch((err) => {
      console.error('[groups] read of an unconfirmed group failed', err);
      return match;
    });
    const saved = await persistGroupSnapshot(admin, channel, full, {
      createdBy: args.createdBy,
    });
    if (!saved) return;
    const mgrError = await saveGroupManagers(
      admin,
      channel.accountId,
      saved.id,
      args.managerIds
    );
    if (mgrError) throw mgrError;
  } catch (err) {
    console.error('[groups] claiming an unconfirmed group failed', err);
  }
}
