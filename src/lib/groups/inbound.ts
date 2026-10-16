// ============================================================
// WhatsApp groups — inbound traffic from the Whapi webhook (migration 114).
//
// Group traffic never enters `inbound-pipeline.ts`: the normaliser keeps
// dropping `@g.us` chats, and this module reads them from the raw body
// on its own. Nothing here creates a contact or a conversation, or
// triggers flows, journeys, automations, the AI or outbound webhooks.
//
// Every write runs on the service role and is confined to the channel
// row the webhook SECRET resolved: a group is matched on
// (account_id, channel_id, wa_group_id), never on the payload alone.
// The extraction is pure; the writers throw on a database error and the
// route isolates them (a webhook must not throw).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import type { NormalizedStatus } from '@/lib/whatsapp/inbound';
import {
  normalizeWhapiMessage,
  type RawWhapiWebhookPayload,
} from '@/lib/whatsapp/whapi-webhook';
import type { WhapiGroupEvent } from '@/lib/whatsapp/whapi-group-events';

import { persistGroupSnapshot } from './server';
import {
  parseGroupSettings,
  type GroupMessageStatus,
  type GroupOurRole,
} from './types';

/** One message in a group chat, as the webhook carried it. */
export interface GroupInboundMessage {
  id: string;
  waGroupId: string;
  fromMe: boolean;
  /** Sender digits, or `<digits>@lid` when WhatsApp hides the number. */
  senderWaId: string | null;
  senderName: string | null;
  type: string;
  body: string | null;
  media: Record<string, unknown> | null;
  /** ISO time WhatsApp stamped the message with. */
  sentAt: string;
}

/** The channel row the webhook secret resolved. */
export interface GroupChannel {
  id: string;
  accountId: string;
  /** The connected phone number (Whapi rows keep it in `waba_id`). */
  wabaId: string | null;
}

const GROUP_CHAT = /@g\.us$/;

function senderOf(from: unknown): string | null {
  if (typeof from !== 'string' || !from) return null;
  const [user, domain] = from.split('@');
  const digits = normalizePhone(user ?? '');
  if (!digits) return null;
  return domain === 'lid' ? `${digits}@lid` : digits;
}

/**
 * Group messages in a Whapi callback body (pure). Only `@g.us` chats; a
 * broadcast list or a 1:1 chat is not a group. Reactions and Whapi
 * `action`s (edits, deletions, membership notices) are skipped, like
 * anything the normaliser cannot represent.
 */
export function extractWhapiGroupMessages(
  body: RawWhapiWebhookPayload | unknown
): GroupInboundMessage[] {
  const raw = (body as RawWhapiWebhookPayload | null)?.messages;
  if (!Array.isArray(raw)) return [];
  const out: GroupInboundMessage[] = [];
  for (const item of raw) {
    try {
      const chatId = item?.chat_id;
      if (typeof chatId !== 'string' || !GROUP_CHAT.test(chatId)) continue;
      const m = normalizeWhapiMessage(item);
      if (!m || m.type === 'unsupported' || m.type === 'reaction') continue;
      let media: Record<string, unknown> | null = null;
      if (m.media) {
        media = {
          id: m.media.id,
          link: m.media.link,
          mime_type: m.media.mimeType,
          filename: m.media.filename,
          file_size: m.media.fileSize,
        };
      } else if (m.location) {
        media = { location: m.location };
      }
      out.push({
        id: m.id,
        waGroupId: chatId,
        fromMe: m.fromMe,
        senderWaId: senderOf(item.from),
        senderName: item.from_name ?? null,
        type: m.type.slice(0, 32),
        body: m.text ?? m.location?.name ?? null,
        media,
        sentAt: new Date(Number(m.timestamp) * 1000).toISOString(),
      });
    } catch {
      // A malformed item is skipped, never fatal.
    }
  }
  return out;
}

/** The account's groups on this number, by WhatsApp id. */
async function knownGroups(
  admin: SupabaseClient,
  channel: GroupChannel,
  waGroupIds: string[]
): Promise<Map<string, { id: string; our_role: GroupOurRole }>> {
  const out = new Map<string, { id: string; our_role: GroupOurRole }>();
  if (waGroupIds.length === 0) return out;
  const { data, error } = await admin
    .from('whatsapp_groups')
    .select('id, wa_group_id, our_role, participants_count, settings')
    .eq('account_id', channel.accountId)
    .eq('channel_id', channel.id)
    .in('wa_group_id', [...new Set(waGroupIds)]);
  if (error) throw error;
  for (const r of (data ?? []) as Array<{
    id: string;
    wa_group_id: string;
    our_role: GroupOurRole;
  }>) {
    out.set(r.wa_group_id, r);
  }
  return out;
}

/**
 * Record group messages of known groups. Idempotent on
 * (group_id, wa_message_id): a redelivery inserts nothing (and 114's
 * trigger therefore bumps nothing). Unknown groups are only counted.
 */
export async function persistGroupMessages(
  admin: SupabaseClient,
  channel: GroupChannel,
  messages: GroupInboundMessage[]
): Promise<{ stored: number; duplicates: number; unknownGroup: number }> {
  if (messages.length === 0) {
    return { stored: 0, duplicates: 0, unknownGroup: 0 };
  }
  const groups = await knownGroups(
    admin,
    channel,
    messages.map((m) => m.waGroupId)
  );
  const rows = [];
  let unknownGroup = 0;
  for (const m of messages) {
    const group = groups.get(m.waGroupId);
    if (!group) {
      unknownGroup++;
      continue;
    }
    rows.push({
      account_id: channel.accountId,
      group_id: group.id,
      wa_message_id: m.id,
      direction: m.fromMe ? 'out' : 'in',
      sender_wa_id: m.senderWaId,
      sender_name: m.senderName,
      type: m.type,
      body: m.body,
      media: m.media,
      created_at: m.sentAt,
    });
  }
  if (unknownGroup > 0) {
    console.log(
      `[groups-webhook] ignored ${unknownGroup} message(s) of unknown group(s) on channel ${channel.id}`
    );
  }
  if (rows.length === 0) return { stored: 0, duplicates: 0, unknownGroup };
  const { data, error } = await admin
    .from('whatsapp_group_messages')
    .upsert(rows, {
      onConflict: 'group_id,wa_message_id',
      ignoreDuplicates: true,
    })
    .select('id');
  if (error) throw error;
  const stored = (data ?? []).length;
  return { stored, duplicates: rows.length - stored, unknownGroup };
}

/**
 * Forward-only ladder for our group sends: pending → sent → delivered
 * → read; `failed` only from pending/sent. Inbound rows (status NULL)
 * never move.
 */
export const GROUP_STATUS_PREDECESSORS: Record<
  GroupMessageStatus,
  readonly GroupMessageStatus[]
> = {
  pending: [],
  sent: ['pending'],
  delivered: ['pending', 'sent'],
  read: ['pending', 'sent', 'delivered'],
  failed: ['pending', 'sent'],
};

/**
 * Apply delivery receipts to this account's outbound group messages.
 * One UPDATE per distinct status value; an id that is not a group
 * message matches nothing.
 */
export async function applyGroupStatuses(
  admin: SupabaseClient,
  channel: GroupChannel,
  statuses: readonly NormalizedStatus[]
): Promise<number> {
  const byStatus = new Map<GroupMessageStatus, string[]>();
  for (const s of statuses) {
    if (GROUP_STATUS_PREDECESSORS[s.status].length === 0) continue;
    const ids = byStatus.get(s.status) ?? [];
    ids.push(s.messageId);
    byStatus.set(s.status, ids);
  }
  let moved = 0;
  for (const [status, ids] of byStatus) {
    const { data, error } = await admin
      .from('whatsapp_group_messages')
      .update({ status })
      .eq('account_id', channel.accountId)
      .eq('direction', 'out')
      .in('wa_message_id', ids)
      .in('status', [...GROUP_STATUS_PREDECESSORS[status]])
      .select('id');
    if (error) throw error;
    moved += (data ?? []).length;
  }
  return moved;
}

type KnownGroup = {
  id: string;
  our_role: GroupOurRole;
  participants_count?: number;
  settings?: unknown;
};

/**
 * Apply Whapi `groups` events to known groups of this number. A group
 * the number itself created (Whapi's `created_by` is our phone) is
 * inserted unowned on `group_upsert`, so admins see it; any other
 * unknown group is ignored. Each event is isolated: one failure is
 * logged and the rest still apply. Returns how many failed.
 */
export async function applyGroupEvents(
  admin: SupabaseClient,
  channel: GroupChannel,
  events: readonly WhapiGroupEvent[]
): Promise<number> {
  if (events.length === 0) return 0;
  const ids = events.map((e) =>
    e.kind === 'group_upsert' ? e.group.id : e.groupId
  );
  const groups = (await knownGroups(admin, channel, ids)) as Map<
    string,
    KnownGroup
  >;
  const ourWaId = normalizePhone(channel.wabaId ?? '') || null;
  let failed = 0;
  let unknown = 0;
  for (const e of events) {
    try {
      if (e.kind === 'group_upsert') {
        const known = groups.has(e.group.id);
        const ours = !!ourWaId && e.group.createdBy?.waId === ourWaId;
        if (!known && !ours) {
          unknown++;
          continue;
        }
        const saved = await persistGroupSnapshot(admin, channel, e.group);
        groups.set(e.group.id, saved);
        continue;
      }
      const group = groups.get(e.groupId);
      if (!group) {
        unknown++;
        continue;
      }
      if (e.kind === 'participants') {
        await applyParticipants(admin, channel, group, e, ourWaId);
      } else {
        await applyUpdate(admin, group, e.changes);
      }
    } catch (err) {
      failed++;
      console.error(`[groups-webhook] ${e.kind} event failed`, err);
    }
  }
  if (unknown > 0) {
    console.log(
      `[groups-webhook] ignored ${unknown} event(s) of unknown group(s) on channel ${channel.id}`
    );
  }
  return failed;
}

async function applyParticipants(
  admin: SupabaseClient,
  channel: GroupChannel,
  group: KnownGroup,
  e: Extract<WhapiGroupEvent, { kind: 'participants' }>,
  ourWaId: string | null
): Promise<void> {
  // A join request changes nothing yet. 114's notifications CHECK has
  // no `group_join_request` type, so no bell either.
  if (e.action === 'request') return;
  const table = () => admin.from('whatsapp_group_participants');
  const patch: Record<string, unknown> = {};
  let delta = 0;

  if (e.action === 'add' && e.waIds.length > 0) {
    const { data, error } = await table()
      .upsert(
        e.waIds.map((waId) => ({
          group_id: group.id,
          account_id: channel.accountId,
          wa_id: waId,
          role: 'member',
        })),
        { onConflict: 'group_id,wa_id', ignoreDuplicates: true }
      )
      .select('wa_id');
    if (error) throw error;
    delta = (data ?? []).length + e.unresolved;
  } else if (e.action === 'remove' && e.waIds.length > 0) {
    const { data, error } = await table()
      .delete()
      .eq('group_id', group.id)
      .in('wa_id', e.waIds)
      .select('wa_id');
    if (error) throw error;
    delta = -((data ?? []).length + e.unresolved);
  } else if (
    (e.action === 'promote' || e.action === 'demote') &&
    e.waIds.length > 0
  ) {
    const { error } = await table()
      .update({ role: e.action === 'promote' ? 'admin' : 'member' })
      .eq('group_id', group.id)
      .in('wa_id', e.waIds);
    if (error) throw error;
  } else if (e.action === 'add' || e.action === 'remove') {
    delta = e.action === 'add' ? e.unresolved : -e.unresolved;
  }

  if (delta !== 0) {
    patch.participants_count = Math.max(
      0,
      (group.participants_count ?? 0) + delta
    );
  }
  if (ourWaId && e.waIds.includes(ourWaId)) {
    const role: GroupOurRole | null =
      e.action === 'remove'
        ? 'left'
        : e.action === 'promote'
          ? 'admin'
          : e.action === 'demote'
            ? 'member'
            : group.our_role === 'left'
              ? 'member'
              : null;
    if (role && role !== group.our_role) patch.our_role = role;
  }
  if (Object.keys(patch).length === 0) return;
  const { error } = await admin
    .from('whatsapp_groups')
    .update(patch)
    .eq('id', group.id);
  if (error) throw error;
  if (typeof patch.participants_count === 'number') {
    group.participants_count = patch.participants_count;
  }
  if (patch.our_role) group.our_role = patch.our_role as GroupOurRole;
}

async function applyUpdate(
  admin: SupabaseClient,
  group: KnownGroup,
  changes: Extract<WhapiGroupEvent, { kind: 'group_update' }>['changes']
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (changes.name !== undefined) patch.name = changes.name.slice(0, 200);
  if (changes.description !== undefined) {
    patch.description = changes.description?.slice(0, 2048) ?? null;
  }
  if (changes.settings) {
    const merged = {
      ...parseGroupSettings(group.settings),
      ...parseGroupSettings(changes.settings),
    };
    patch.settings = merged;
    group.settings = merged;
  }
  if (Object.keys(patch).length === 0) return;
  const { error } = await admin
    .from('whatsapp_groups')
    .update(patch)
    .eq('id', group.id);
  if (error) throw error;
}
