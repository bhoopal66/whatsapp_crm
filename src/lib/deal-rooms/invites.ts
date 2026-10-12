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
 * yet. Each person is claimed before the send (a
 * `pending:<epoch ms>:<uuid>` marker in `invite_message_id`, set only
 * where it is NULL), so a webhook redelivery and a re-send racing each
 * other invite nobody twice; a failed send releases the claim for the
 * next attempt.
 *
 * A process that dies between the claim and its result would leave the
 * marker for good, and the table has no timestamp to date it by, so the
 * marker carries its own time. `releaseStaleInviteClaims` frees the
 * claims older than 30 minutes (`STALE_INVITE_CLAIM_MS`), each with a
 * write conditional on the exact marker it read, and the reconcile (every
 * 2 minutes, from the cron) then runs this room's invites again. A marker
 * with no readable time (the earlier `pending:<uuid>` form) counts as
 * stale. Accepted risk: a send that went out but whose result was never
 * recorded is invited a second time; one person twice is better than
 * someone never invited.
 *
 * Right before each send the person is re-checked with
 * `deal_room_admit_block` (migration 088), the rule join-request
 * auto-approval uses: the room still open, nobody opted out or marked
 * do-not-contact, a customer with their recorded consent, a bank guest
 * whose bank still allows guests. Whoever fails it is skipped, unclaimed,
 * and the reason goes into the `invites_sent` audit row.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { sendGroupInviteTemplate } from '@/lib/whatsapp/meta-groups';

import { loadDealRoomSettings, pickInviteTemplate } from './settings';
import { metaChannel, notifyRoomCreator, type RoomRef } from './shared';

/** A claim older than this belongs to a process that died. */
export const STALE_INVITE_CLAIM_MS = 30 * 60_000;

const CLAIM_PREFIX = 'pending:';
const CLAIM_TIME = /^pending:(\d{1,15}):./;

/** The marker written into `invite_message_id` before a send. */
export function buildInviteClaim(
  now: Date = new Date(),
  id: string = randomUUID()
): string {
  return `${CLAIM_PREFIX}${now.getTime()}:${id}`;
}

/**
 * Reads an `invite_message_id`: null when it is not a claim (empty, or
 * Meta's message id); otherwise the time it was claimed (epoch ms), or
 * null when the marker carries none.
 */
export function parseInviteClaim(
  marker: string | null | undefined
): { claimedAt: number | null } | null {
  if (typeof marker !== 'string' || !marker.startsWith(CLAIM_PREFIX)) {
    return null;
  }
  const m = CLAIM_TIME.exec(marker);
  return { claimedAt: m ? Number(m[1]) : null };
}

/** A claim of unknown age, or older than `maxAgeMs`; never a message id. */
export function isStaleInviteClaim(
  marker: string | null | undefined,
  now: Date,
  maxAgeMs: number = STALE_INVITE_CLAIM_MS
): boolean {
  const claim = parseInviteClaim(marker);
  if (!claim) return false;
  return claim.claimedAt === null || now.getTime() - claim.claimedAt > maxAgeMs;
}

/**
 * Frees the invites claimed more than 30 minutes ago and never settled,
 * and returns the ids of the rooms touched. Each release is conditional
 * on the exact marker read, so a claim replaced meanwhile (settled, or
 * claimed again) is left alone. A failed write is logged and skipped.
 */
export async function releaseStaleInviteClaims(
  db: SupabaseClient,
  now: Date = new Date()
): Promise<string[]> {
  const { data, error } = await db
    .from('deal_room_participants')
    .select('id, room_id, invite_message_id')
    .eq('status', 'invited')
    .like('invite_message_id', `${CLAIM_PREFIX}%`);
  if (error) throw new Error(`stale claim lookup failed: ${error.message}`);
  const rooms = new Set<string>();
  for (const p of (data ?? []) as {
    id: string;
    room_id: string;
    invite_message_id: string;
  }[]) {
    if (!isStaleInviteClaim(p.invite_message_id, now)) continue;
    const { data: released, error: releaseErr } = await db
      .from('deal_room_participants')
      .update({ invite_message_id: null })
      .eq('id', p.id)
      .eq('status', 'invited')
      .eq('invite_message_id', p.invite_message_id)
      .select('id')
      .maybeSingle();
    if (releaseErr) {
      console.error(
        '[deal-rooms] stale claim not released:',
        releaseErr.message
      );
      continue;
    }
    if (!released) continue; // settled or claimed again since the read
    console.warn(
      `[deal-rooms] released a stale invite claim (room ${p.room_id}, participant ${p.id})`
    );
    rooms.add(p.room_id);
  }
  return [...rooms];
}

export interface InviteSummary {
  sent: number;
  failed: number;
  /**
   * Not due: pending approval, already invited, our number, claimed
   * elsewhere, or blocked by the re-check (the audit row says why).
   */
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
  const blocked: { participant_id: string; reason: string }[] = [];
  for (const p of due) {
    const { data: block, error: blockErr } = await db.rpc(
      'deal_room_admit_block',
      { p_participant: p.id }
    );
    if (blockErr) {
      summary.failed += 1; // unchecked is unsent
      firstError ??= blockErr.message;
      continue;
    }
    if (block) {
      summary.skipped += 1;
      blocked.push({ participant_id: p.id, reason: String(block) });
      continue;
    }
    const claim = buildInviteClaim();
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
      blocked,
    },
  });
  if (auditErr) console.error('[deal-rooms] audit failed:', auditErr.message);
  return summary;
}
