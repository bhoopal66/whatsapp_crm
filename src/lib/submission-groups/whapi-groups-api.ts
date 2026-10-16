/**
 * The submission-group service's `GroupsApi` port over the Whapi group
 * calls in `lib/whatsapp/groups.ts`. One adapter per account: every
 * channel id it is handed is looked up among that account's numbers
 * (`loadChannels`, tokens decrypted there), so a group row can never
 * drive another account's number.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { loadChannels, type WhatsAppChannel } from '@/lib/whatsapp/channels';
import * as groups from '@/lib/whatsapp/groups';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { WhapiError } from '@/lib/whatsapp/whapi-api';

import type { GroupsApi } from './service';

/** The group's number is gone from the account (or never belonged to it). */
export class SubmissionGroupChannelError extends Error {
  override readonly name = 'SubmissionGroupChannelError';
  constructor(readonly channelId: string) {
    super(`WhatsApp number ${channelId} is not connected to this account`);
  }
}

const isGroupGone = (err: unknown): boolean =>
  err instanceof WhapiError && err.isGroupNotFound;

export function createWhapiGroupsApi(
  admin: SupabaseClient,
  accountId: string
): GroupsApi {
  // Loaded per call rather than cached: a reconnected number carries a
  // new token, and the adapter may outlive a single request in the cron.
  async function channelFor(channelId: string): Promise<WhatsAppChannel> {
    const channels = await loadChannels(admin, accountId);
    const channel = channels.find((c) => c.id === channelId);
    if (!channel) throw new SubmissionGroupChannelError(channelId);
    if (channel.provider !== 'whapi') {
      throw new groups.GroupsUnsupportedError(channel.provider);
    }
    return channel;
  }

  return {
    // Whapi has no idempotency key on group creation; the service's
    // create lease (sg_claim_create) is what keeps this to one call.
    async createGroup(channelId, participants, subject) {
      const channel = await channelFor(channelId);
      const made = await groups.createGroup({
        channel,
        name: subject,
        participants,
        deadline: groups.groupDeadline(),
      });
      const waGroupId = made.group?.id;
      if (!waGroupId) throw new Error('Whapi created no group');
      // Everyone asked for who did not end up in the group: refused by
      // WhatsApp, never attempted, or not a usable number at all.
      const refused = [
        ...made.refused.map((p) => p.waId ?? p.jid),
        ...made.notAttempted,
        ...made.invalid,
      ];
      let inviteLink: string | null = null;
      try {
        inviteLink = (
          await groups.getInviteLink({ channel, groupId: waGroupId })
        ).link;
      } catch {
        // Best-effort: the group exists, the link can be fetched later.
      }
      return { waGroupId, inviteLink, refused };
    },

    async sendGroupText(channelId, waGroupId, text) {
      const channel = await channelFor(channelId);
      const sent = await groups.sendGroupText({
        channel,
        groupId: waGroupId,
        text,
      });
      return { waMessageId: sent.messageId };
    },

    /**
     * Remove everyone but our own number, then leave. A group WhatsApp
     * no longer knows on this number (404) is already closed.
     */
    async closeGroup(channelId, waGroupId) {
      const channel = await channelFor(channelId);
      const ref = { channel, groupId: waGroupId };
      let group: groups.Group;
      try {
        group = await groups.getGroup(ref);
      } catch (err) {
        if (isGroupGone(err)) return;
        throw err;
      }
      const ours = normalizePhone(channel.wabaId ?? '') || null;
      const others = group.participants
        .map((p) => p.waId)
        .filter((w): w is string => !!w && w !== ours);
      try {
        if (others.length > 0) {
          await groups.removeParticipants({ ...ref, participants: others });
        }
        await groups.leaveGroup(ref);
      } catch (err) {
        if (isGroupGone(err)) return;
        throw err;
      }
    },
  };
}
