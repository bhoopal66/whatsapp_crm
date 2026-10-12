/**
 * Deal rooms — inviting the people (module 014c, migration 088).
 *
 * Once the group exists, each listed person gets the invite template
 * 1:1 from the Meta number, with the group id that Meta turns into the
 * invite link. Runs on the service role: from the `group_create`
 * webhook, from the reconcile, and from a manager's re-send.
 *
 * Who: status `invited` (a bank guest an agent listed stays
 * `pending_approval` until a team leader lets them in), a phone, a role
 * other than `business` (our own number), and no `invite_message_id`
 * yet. Each person is claimed before the send (a `pending:` marker in
 * `invite_message_id`, set only where it is NULL), so a webhook
 * redelivery and a re-send racing each other invite nobody twice; a
 * failed send releases the claim for the next attempt.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { sendGroupInviteTemplate } from '@/lib/whatsapp/meta-groups';

import { loadDealRoomSettings, pickInviteTemplate } from './settings';
import { metaChannel, notifyRoomCreator, type RoomRef } from './shared';

export interface InviteSummary {
  sent: number;
  failed: number;
  /** Not due: pending approval, already invited, our number, or claimed elsewhere. */
  skipped: number;
  /** The room is not open (no group yet): nothing was sent. */
  notOpen: boolean;
  /** No invite template is configured: the creator was notified. */
  templateMissing: boolean;
}

interface Participant {
  id: string;
  phone: string | null;
  role: string | null;
  status: string;
  invite_message_id: string | null;
}

interface Room extends RoomRef {
  status: string;
  wa_group_id: string | null;
  whatsapp_config_id: string | null;
}

export async function sendRoomInvites(
  db: SupabaseClient,
  roomId: string
): Promise<InviteSummary> {
  const summary: InviteSummary = {
    sent: 0,
    failed: 0,
    skipped: 0,
    notOpen: false,
    templateMissing: false,
  };
  const { data: roomData, error: roomErr } = await db
    .from('deal_rooms')
    .select(
      'id, account_id, channel_id, created_by, subject, status, wa_group_id, whatsapp_config_id'
    )
    .eq('id', roomId)
    .maybeSingle();
  if (roomErr) throw new Error(`room lookup failed: ${roomErr.message}`);
  const room = roomData as Room | null;
  if (!room || room.status !== 'open' || !room.wa_group_id) {
    return { ...summary, notOpen: true };
  }
  const groupId = room.wa_group_id;

  const { data: people, error: peopleErr } = await db
    .from('deal_room_participants')
    .select('id, phone, role, status, invite_message_id')
    .eq('room_id', roomId);
  if (peopleErr) {
    throw new Error(`participant lookup failed: ${peopleErr.message}`);
  }
  const all = (people ?? []) as Participant[];
  const due = all.filter(
    (p) =>
      p.status === 'invited' &&
      !p.invite_message_id &&
      !!p.phone &&
      !!p.role &&
      p.role !== 'business'
  );
  summary.skipped = all.length - due.length;
  if (due.length === 0) return summary;

  // No stored language preference exists yet, so everyone gets the
  // default copy; pickInviteTemplate takes one once there is.
  const template = pickInviteTemplate(
    await loadDealRoomSettings(db, room.account_id),
    null
  );
  if (!template) {
    await notifyRoomCreator(db, room, 'Invite template not configured', {
      event: 'invite_template_missing',
    });
    return {
      ...summary,
      skipped: summary.skipped + due.length,
      templateMissing: true,
    };
  }
  const channel = await metaChannel(
    db,
    room.account_id,
    room.whatsapp_config_id
  );
  if (!channel) throw new Error("the room's Meta number is not connected");

  let firstError: string | null = null;
  for (const p of due) {
    const claim = `pending:${randomUUID()}`;
    const { data: claimed, error: claimErr } = await db
      .from('deal_room_participants')
      .update({ invite_message_id: claim })
      .eq('id', p.id)
      .eq('status', 'invited')
      .is('invite_message_id', null)
      .select('id')
      .maybeSingle();
    if (claimErr) {
      summary.failed += 1;
      firstError ??= claimErr.message;
      continue;
    }
    if (!claimed) {
      summary.skipped += 1; // another sender holds this person
      continue;
    }
    try {
      const { messageId } = await sendGroupInviteTemplate({
        phoneNumberId: channel.phoneNumberId,
        accessToken: channel.accessToken,
        to: p.phone as string,
        templateName: template.name,
        language: template.language,
        groupId,
      });
      const { error } = await db
        .from('deal_room_participants')
        .update({
          invite_message_id: messageId,
          invited_at: new Date().toISOString(),
        })
        .eq('id', p.id)
        .eq('invite_message_id', claim);
      // The invite went out; the claim left in place keeps it from going twice.
      if (error)
        console.error('[deal-rooms] invite not recorded:', error.message);
      summary.sent += 1;
    } catch (err) {
      summary.failed += 1;
      firstError ??= err instanceof Error ? err.message : String(err);
      await db
        .from('deal_room_participants')
        .update({ invite_message_id: null })
        .eq('id', p.id)
        .eq('invite_message_id', claim);
    }
  }

  const { error: auditErr } = await db.from('deal_room_audit').insert({
    room_id: room.id,
    account_id: room.account_id,
    actor_id: null,
    action: 'invites_sent',
    detail: {
      sent: summary.sent,
      failed: summary.failed,
      template: template.name,
      language: template.language,
      error: firstError,
    },
  });
  if (auditErr) console.error('[deal-rooms] audit failed:', auditErr.message);
  return summary;
}
