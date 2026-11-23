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

import { planClose } from './close-plan';
import {
  isNumberFailure,
  SubmissionGroupChannelError,
  SubmissionGroupNotAttemptedError,
  SubmissionGroupNumberDisconnectedError,
  type FoundGroup,
  type GroupsApi,
} from './service';
import { SubmissionGroupCloseIncompleteError } from './wa-errors';

export { SubmissionGroupChannelError };

/** One read gives up here, so a hanging number cannot eat the cron's budget. */
export const PARTICIPANTS_TIMEOUT_MS = 8_000;

/**
 * The create call itself. Longer than a paced call (15 s): giving up on it
 * leaves a group nobody knows about. The lookup, the create, its batches and
 * the invite link together stay inside the 120 s create lease.
 */
export const CREATE_TIMEOUT_MS = 40_000;
/** One read of the lookup before a retried create. */
export const LOOKUP_CALL_TIMEOUT_MS = 8_000;
/** No lookup read starts after this. */
export const LOOKUP_BUDGET_MS = 20_000;

const isGroupGone = (err: unknown): boolean =>
  err instanceof WhapiError && err.isGroupNotFound;

/** A close's read of the group, and each of its calls that change it. */
export const CLOSE_READ_TIMEOUT_MS = 8_000;
export const CLOSE_CALL_TIMEOUT_MS = 15_000;

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

/** Taking a staff member's saved number out of a group (staff-number.ts). */
export interface RemoveParticipantApi {
  /** Removes one number (digits); never our own number. Throws on failure. */
  removeParticipant(
    channelId: string,
    waGroupId: string,
    phone: string
  ): Promise<void>;
}

export function createWhapiGroupsApi(
  admin: SupabaseClient,
  accountId: string
): GroupsApi & ParticipantsApi & RemoveParticipantApi {
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
      let channel: WhatsAppChannel;
      try {
        channel = await channelFor(channelId);
      } catch (err) {
        if (err instanceof SubmissionGroupChannelError) throw err;
        throw new SubmissionGroupNotAttemptedError(err);
      }
      const made = await groups.createGroup({
        channel,
        name: subject,
        participants,
        deadline: groups.groupDeadline(),
        createTimeoutMs: CREATE_TIMEOUT_MS,
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

    async findCreatedGroups(channelId, subject, since) {
      const channel = await channelFor(channelId);
      const deadline = Date.now() + LOOKUP_BUDGET_MS;
      const call = { channel, timeoutMs: LOOKUP_CALL_TIMEOUT_MS };
      const named = await groups.findGroupsNamed({
        ...call,
        name: subject,
        deadline,
      });
      const ours = normalizePhone(channel.wabaId ?? '') || null;
      const found: FoundGroup[] = [];
      for (const g of named) {
        if (g.createdAt !== null && g.createdAt * 1000 < since.getTime())
          continue;
        if (!groups.withinBudget({ deadline }))
          throw new Error('the groups with this name could not all be read');
        let full: groups.Group;
        try {
          // The list may leave members out.
          full = await groups.getGroup({ ...call, groupId: g.id });
        } catch (err) {
          if (isGroupGone(err)) continue;
          throw err;
        }
        const creator = full.createdBy?.waId ?? g.createdBy?.waId ?? null;
        if (full.terminated || (ours && creator && creator !== ours)) continue;
        const members = full.participants.map((p) => p.waId ?? p.jid);
        // A group we have left; a hidden id may be our own number.
        if (
          ours &&
          members.length > 0 &&
          !members.includes(ours) &&
          !members.some((m) => m.includes('@'))
        )
          continue;
        const createdAt = full.createdAt ?? g.createdAt;
        found.push({
          waGroupId: g.id,
          createdAt: createdAt === null ? null : new Date(createdAt * 1000),
          others: members.filter((m) => m !== ours),
        });
      }
      return found;
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

    async sendGroupMedia(channelId, waGroupId, media) {
      const channel = await channelFor(channelId);
      const sent = await groups.sendGroupMedia({
        channel,
        groupId: waGroupId,
        kind: media.kind,
        link: media.link,
        caption: media.caption,
        filename: media.filename,
        mimeType: media.mimeType,
      });
      return { waMessageId: sent.messageId };
    },

    async sendInvite(channelId, inviteCode, to) {
      const channel = await channelFor(channelId);
      await groups.sendInviteLink({ channel, inviteCode, to });
    },

    async addParticipant(channelId, waGroupId, phone) {
      const channel = await channelFor(channelId);
      const out = await groups.addParticipants({
        channel,
        groupId: waGroupId,
        participants: [phone],
        deadline: groups.groupDeadline(),
      });
      if (out.added.length > 0) return 'added';
      // Only WhatsApp declining (or a number it rejects) is 'refused'.
      // Never tried (a failed call, the deadline) is a failure.
      if (out.refused.length > 0 || out.invalid.length > 0) return 'refused';
      throw new Error(
        `add participant failed: ${out.error ?? 'not attempted'}`
      );
    },

    async removeParticipant(channelId, waGroupId, phone) {
      const channel = await channelFor(channelId);
      const ours = normalizePhone(channel.wabaId ?? '');
      if (ours && normalizePhone(phone) === ours)
        throw new Error('refusing to remove our own number');
      const out = await groups.removeParticipants({
        channel,
        groupId: waGroupId,
        participants: [phone],
      });
      if (out.failed.length > 0) throw new Error('remove participant failed');
    },

    async getInviteLink(channelId, waGroupId) {
      const channel = await channelFor(channelId);
      return (await groups.getInviteLink({ channel, groupId: waGroupId })).link;
    },

    /**
     * Remove everyone but our own number, then leave: only once nobody else
     * is in it, so a partial failure throws and is retried, until the caller
     * gives up on them (`leaveAnyway`). A group WhatsApp
     * no longer knows on this number (404) is already closed; a number
     * marked disconnected is never asked, its 404 would say the same.
     */
    async closeGroup(channelId, waGroupId, opts) {
      const channel = await channelFor(channelId);
      if (channel.status === 'disconnected')
        throw new SubmissionGroupNumberDisconnectedError(channelId);
      const ref = {
        channel,
        groupId: waGroupId,
        timeoutMs: CLOSE_CALL_TIMEOUT_MS,
      };
      let group: groups.Group;
      try {
        group = await groups.getGroup({
          ...ref,
          timeoutMs: CLOSE_READ_TIMEOUT_MS,
        });
      } catch (err) {
        if (isGroupGone(err)) return;
        throw err;
      }
      const plan = planClose(
        group.participants,
        normalizePhone(channel.wabaId ?? '') || null
      );
      let remaining = plan.unreachable;
      const remove = async (participants: string[]) => {
        if (participants.length === 0) return;
        const out = await groups.removeParticipants({
          ...ref,
          participants,
          includeHidden: true,
        });
        remaining += out.failed.length;
      };
      try {
        await remove(plan.phones);
        // On their own: a gateway that will not take a hidden id must not
        // stop the others from being removed.
        try {
          await remove(plan.hidden);
        } catch (err) {
          if (isNumberFailure(err) || isGroupGone(err)) throw err;
          remaining += plan.hidden.length;
        }
        if (remaining > 0 && !opts?.leaveAnyway)
          throw new SubmissionGroupCloseIncompleteError(remaining);
        if (remaining > 0)
          console.warn(
            `[submission-groups] left a group with ${remaining} still in it`
          );
        await groups.leaveGroup(ref);
      } catch (err) {
        if (isGroupGone(err)) return;
        throw err;
      }
    },
  };
}
