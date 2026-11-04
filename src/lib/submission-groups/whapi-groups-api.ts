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

import { SubmissionGroupChannelError, type GroupsApi } from './service';

export { SubmissionGroupChannelError };

/** One read gives up here, so a hanging number cannot eat the cron's budget. */
export const PARTICIPANTS_TIMEOUT_MS = 8_000;

const isGroupGone = (err: unknown): boolean =>
  err instanceof WhapiError && err.isGroupNotFound;

/** The cron's read of who is in a group (174). */
export interface ParticipantsApi {
  /**
   * Everyone in the group: phone digits, or the raw id of a hidden number
   * (`…@lid`). null when the group or number is gone, so asking again won't
   * help, or the number is disconnected, so no call is made. Any other failure
   * throws.
   */
  getParticipants(
    channelId: string,
    waGroupId: string
  ): Promise<string[] | null>;
}

export function createWhapiGroupsApi(
  admin: SupabaseClient,
  accountId: string
): GroupsApi & ParticipantsApi {
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

    async getParticipants(channelId, waGroupId) {
      try {
        const channel = await channelFor(channelId);
        // A background check must never wake a stopped channel, and nothing
        // confirms that GET /groups/{id} does not: this gate is what holds.
        if (channel.status === 'disconnected') return null;
        const group = await groups.getGroup({
          channel,
          groupId: waGroupId,
          timeoutMs: PARTICIPANTS_TIMEOUT_MS,
        });
        return group.participants.map((p) => p.waId ?? p.jid);
      } catch (err) {
        if (
          isGroupGone(err) ||
          err instanceof SubmissionGroupChannelError ||
          err instanceof groups.GroupsUnsupportedError
        )
          return null;
        throw err;
      }
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

    async sendInvite(channelId, inviteCode, to) {
      const channel = await channelFor(channelId);
      await groups.sendInviteLink({ channel, inviteCode, to });
    },

    async getInviteLink(channelId, waGroupId) {
      const channel = await channelFor(channelId);
      return (await groups.getInviteLink({ channel, groupId: waGroupId })).link;
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
      // Our number is the one on file, and in any case the group's creator
      // (we created it): skip both, so a missing or placeholder wabaId never
      // makes the close try to remove ourselves and fail on every retry.
      const ours = normalizePhone(channel.wabaId ?? '') || null;
      const others = group.participants
        .filter((p) => p.role !== 'superadmin')
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
