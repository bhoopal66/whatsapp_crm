/**
 * Deal rooms — the Meta webhook side (module 014c, migration 088).
 *
 * The Meta route hands over, per verified number, every `value` that
 * belongs to a group: the four `group_*` fields (`value.groups[]`) and
 * the group part of a `messages` change (messages carrying `group_id`,
 * statuses with `recipient_type: 'group'`). None of it may reach the 1:1
 * inbox. Everything is written through 088's service-role functions,
 * which dedupe redeliveries.
 *
 * Never throws for one bad item: each is logged and the rest go on. A
 * group no room of this account knows (P0002, or a room of another
 * account) is logged and ignored — Meta still delivers late webhooks
 * for deleted groups.
 */

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { markOptedOut } from '@/lib/ai/opt-out';
import { downloadMedia, getMediaUrl } from '@/lib/whatsapp/meta-api';
import { MetaError } from '@/lib/whatsapp/meta-api';
import { phoneVariants } from '@/lib/whatsapp/phone-utils';
import {
  approveJoinRequests,
  deleteGroup,
  removeParticipants,
} from '@/lib/whatsapp/meta-groups';

import { sendRoomInvites } from './invites';
import { alertRecipients, workspaceAdminIds } from './shared';

export const GROUP_WEBHOOK_FIELDS = [
  'group_lifecycle_update',
  'group_participants_update',
  'group_settings_update',
  'group_status_update',
] as const;

const DEAL_FILES_BUCKET = 'deal-files';
const MEDIA_TYPES = new Set(['image', 'document', 'audio', 'video', 'sticker']);

type Json = Record<string, unknown>;

export interface GroupWebhookValue {
  metadata?: { phone_number_id?: string };
  groups?: unknown[];
  messages?: unknown[];
  statuses?: unknown[];
  contacts?: unknown[];
  [key: string]: unknown;
}

function obj(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function str(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value ? value : null;
}

function digits(value: unknown): string | null {
  const d = (str(value) ?? '').replace(/\D/g, '');
  return d || null;
}

/** A change under one of the four Groups API webhook fields. */
export function isGroupChange(change: unknown): boolean {
  const field = obj(change).field;
  return (GROUP_WEBHOOK_FIELDS as readonly unknown[]).includes(field);
}

/**
 * A message written inside a group (`group_id` present): never 1:1.
 * The Meta normaliser skips exactly these, so each message has one home.
 */
export function isGroupMessage(message: unknown): boolean {
  return str(obj(message).group_id) !== null;
}

/** A receipt for our own group send (`recipient_type: 'group'`). */
export function isGroupStatus(status: unknown): boolean {
  return obj(status).recipient_type === 'group';
}

/** Messages written inside a group (`group_id` present): never 1:1. */
export function groupMessages(value: unknown): Json[] {
  const messages = obj(value).messages;
  return (Array.isArray(messages) ? messages : [])
    .map(obj)
    .filter(isGroupMessage);
}

/** Receipts for our own group sends (`recipient_type: 'group'`). */
export function groupStatuses(value: unknown): Json[] {
  const statuses = obj(value).statuses;
  return (Array.isArray(statuses) ? statuses : [])
    .map(obj)
    .filter(isGroupStatus);
}

/**
 * Trimmed, case- and diacritic-insensitive: NFKD splits a hamza seat
 * (إ → ا + mark) and Latin accents into marks, which are then dropped
 * with the Arabic harakat and the tatweel.
 */
function foldKeyword(text: string): string {
  return text
    .trim()
    .normalize('NFKD')
    .replace(/[\p{M}ـ]/gu, '')
    .toLowerCase();
}

const OPT_OUT_KEYWORDS = new Set(
  ['STOP', 'UNSUBSCRIBE', 'إلغاء', 'الغاء', 'ايقاف', 'إيقاف'].map(foldKeyword)
);

export function isOptOutText(text: unknown): boolean {
  return typeof text === 'string' && OPT_OUT_KEYWORDS.has(foldKeyword(text));
}

export interface GroupSettingsChange {
  subject?: string;
  /** null: the description was cleared. */
  description?: string | null;
  join_approval_mode?: 'approval_required' | 'auto_approve';
}

const JOIN_APPROVAL_MODES = new Set(['approval_required', 'auto_approve']);

/** Postgres counts characters by code point, as this does. */
const chars = (text: string) => [...text].length;

/**
 * What a `group_settings_update` event changed, in the room's terms
 * (deal_room_apply_settings, migration 100), or null when it names
 * nothing usable. Never throws.
 *
 * The shape is ASSUMED from Meta's Groups API pages and has not been
 * seen on a live callback: each changed setting is an object beside
 * `group_id` — `group_subject` and `group_description`, each with `text`
 * and `update_successful` — and the join approval mode, if Meta sends
 * it, is taken as `join_approval_mode`, a string or `{ mode }`. A
 * setting counts when its update succeeded (`update_successful: true`,
 * or no flag on an event reporting no errors). Anything else — another
 * shape, a failed update, a subject that is blank or over 128
 * characters, a description over 2048 — is ignored.
 */
export function parseGroupSettings(event: unknown): GroupSettingsChange | null {
  const e = obj(event);
  const hasErrors = (o: Json) => Array.isArray(o.errors) && o.errors.length > 0;
  const succeeded = (s: Json) =>
    s.update_successful === true ||
    (s.update_successful === undefined && !hasErrors(e) && !hasErrors(s));
  const out: GroupSettingsChange = {};

  const subject = obj(e.group_subject);
  if (typeof subject.text === 'string' && succeeded(subject)) {
    const text = subject.text.trim();
    if (chars(text) >= 1 && chars(text) <= 128) out.subject = text;
  }
  const description = obj(e.group_description);
  if (typeof description.text === 'string' && succeeded(description)) {
    const text = description.text.trim();
    if (chars(text) <= 2048) out.description = text || null;
  }
  const rawMode = e.join_approval_mode;
  const mode =
    typeof rawMode === 'string'
      ? hasErrors(e)
        ? null
        : rawMode
      : succeeded(obj(rawMode))
        ? str(obj(rawMode).mode)
        : null;
  if (mode && JOIN_APPROVAL_MODES.has(mode)) {
    out.join_approval_mode = mode as GroupSettingsChange['join_approval_mode'];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The contact a group member's WhatsApp id belongs to, among rows read
 * by `contacts.phone_normalized` (migration 022, digits only, so a
 * stored "+971 50…" matches): the one on the earliest `phoneVariants`
 * form, the exact number before its trunk-0 forms.
 */
export function pickContactByPhone(
  rows: unknown,
  variants: string[]
): string | null {
  let best: { id: string; rank: number } | null = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = str(obj(row).id);
    const rank = variants.indexOf(str(obj(row).phone_normalized) ?? '');
    if (id && rank >= 0 && (!best || rank < best.rank)) best = { id, rank };
  }
  return best?.id ?? null;
}

interface Room {
  id: string;
  channel_id: string;
  deal_id: string | null;
  created_by: string | null;
  subject: string;
}

export interface HandleGroupWebhookArgs {
  db: SupabaseClient;
  accountId: string;
  phoneNumberId: string;
  accessToken: string;
  value: GroupWebhookValue;
}

class UnknownGroup extends Error {}

export async function handleGroupWebhook(
  args: HandleGroupWebhookArgs
): Promise<void> {
  const { db, accountId } = args;
  const rooms = new Map<string, Room | null>();

  // The room of this ACCOUNT for a group id; the id alone is global.
  async function room(groupId: string): Promise<Room> {
    if (!rooms.has(groupId)) {
      const { data, error } = await db
        .from('deal_rooms')
        .select('id, channel_id, deal_id, created_by, subject')
        .eq('account_id', accountId)
        .eq('wa_group_id', groupId)
        .maybeSingle();
      if (error) throw new Error(`room lookup failed: ${error.message}`);
      rooms.set(groupId, (data as Room | null) ?? null);
    }
    const found = rooms.get(groupId);
    if (!found) throw new UnknownGroup(groupId);
    return found;
  }

  async function rpc(fn: string, params: Json): Promise<unknown> {
    const { data, error } = await db.rpc(fn, params);
    if (error) {
      if ((error as { code?: string }).code === 'P0002') {
        throw new UnknownGroup(
          String(params.p_group_id ?? params.p_request_id)
        );
      }
      throw new Error(`${fn} failed: ${error.message}`);
    }
    return data;
  }

  async function notify(
    userIds: (string | null)[],
    type: 'deal_room_join_request' | 'deal_room_update',
    r: Room,
    title: string,
    meta: Json
  ): Promise<void> {
    const users = alertRecipients(userIds);
    if (users.length === 0) return;
    const { error } = await db.from('notifications').insert(
      users.map((user_id) => ({
        account_id: accountId,
        user_id,
        type,
        title,
        body: r.subject,
        meta: { room_id: r.id, channel_id: r.channel_id, ...meta },
      }))
    );
    if (error) console.error('[deal-rooms] notification failed:', error);
  }

  // Who manages a room: its creator and the admins of its channel.
  async function managers(r: Room): Promise<(string | null)[]> {
    const { data, error } = await db
      .from('chat_channel_members')
      .select('user_id')
      .eq('channel_id', r.channel_id)
      .eq('role', 'admin');
    if (error) console.error('[deal-rooms] manager lookup failed:', error);
    return [
      r.created_by,
      ...((data ?? []) as { user_id: string }[]).map((m) => m.user_id),
    ];
  }

  // A late group of a cancelled room: best-effort, never retried.
  async function discardGroup(groupId: string): Promise<void> {
    try {
      await deleteGroup({ groupId, accessToken: args.accessToken });
    } catch (err) {
      if (err instanceof MetaError && err.isGroupUnknown) return;
      console.error('[deal-rooms] cancelled room group not deleted:', err);
    }
  }

  async function each<T>(
    items: T[],
    what: string,
    run: (item: T) => Promise<void>
  ) {
    for (const item of items) {
      try {
        await run(item);
      } catch (err) {
        if (err instanceof UnknownGroup) {
          console.warn(
            `[deal-rooms] ${what} for a group no room knows; ignored`
          );
        } else {
          console.error(`[deal-rooms] ${what} failed:`, err);
        }
      }
    }
  }

  const value = obj(args.value);
  const events = (Array.isArray(value.groups) ? value.groups : []).map(obj);
  await each(events, 'group event', (event) => groupEvent(event));
  await each(groupMessages(value), 'group message', (m) => inbound(m));
  await each(groupStatuses(value), 'group receipt', (s) => receipt(s));

  async function groupEvent(event: Json): Promise<void> {
    const type = str(event.type);
    const groupId = str(event.group_id);
    const failed = Array.isArray(event.errors) && event.errors.length > 0;
    const reason = failed
      ? (str(obj(event.errors && (event.errors as unknown[])[0]).message) ??
        'Meta reported an error')
      : null;

    if (type === 'group_create') {
      const requestId = str(event.request_id);
      if (!requestId)
        return console.warn('[deal-rooms] group_create without request_id');
      if (!failed && groupId) {
        const link = str(event.invite_link);
        const roomId = await rpc('deal_room_group_created', {
          p_account: accountId,
          p_request_id: requestId,
          p_group_id: groupId,
          p_invite_link_hash: link
            ? createHash('sha256').update(link).digest('hex')
            : null,
        });
        // The room is open: invite its people. Claim-then-send, so a
        // redelivered webhook invites nobody twice.
        if (typeof roomId === 'string') await sendRoomInvites(db, roomId);
        // NULL: the room was cancelled while being created (096), and no
        // other room holds the group (that one raises instead). The group
        // holds only our number; delete it so it is not left over.
        else if (roomId === null) await discardGroup(groupId);
        return;
      }
      const { data, error } = await db
        .from('deal_rooms')
        .select('id, channel_id, deal_id, created_by, subject')
        .eq('account_id', accountId)
        .eq('create_request_id', requestId)
        .maybeSingle();
      if (error) throw new Error(`room lookup failed: ${error.message}`);
      if (!data) throw new UnknownGroup(requestId);
      const r = data as Room;
      // Fails it only while it is still `creating`, under its row lock
      // (096). Cancelled (even after the read above), already failed or
      // open: nothing changed, and nobody needs telling.
      const changed = await rpc('deal_room_fail_creation', {
        p_room: r.id,
        p_reason: reason,
      });
      if (changed !== true) return;
      await notify(
        [r.created_by, ...(await workspaceAdminIds(db, accountId))],
        'deal_room_update',
        r,
        'Deal room could not be created',
        {
          event: 'create_failed',
          reason,
        }
      );
      return;
    }
    if (!groupId) return;
    const r = await room(groupId);

    switch (type) {
      case 'group_delete':
        if (failed)
          return console.warn(`[deal-rooms] group_delete failed: ${reason}`);
        await rpc('deal_room_set_status', {
          p_room: r.id,
          p_status: 'closed',
          p_reason: 'group deleted',
        });
        return;
      case 'group_participants_add':
        for (const p of arr(event.added_participants)) {
          const waId = digits(p.wa_id ?? p.input);
          if (waId) await participant(groupId, waId, 'joined');
        }
        return;
      case 'group_participants_remove': {
        // Meta's samples put initiated_by beside the group object.
        const by = str(event.initiated_by) ?? str(value.initiated_by);
        for (const p of arr(event.removed_participants)) {
          const waId = digits(p.wa_id ?? p.input);
          if (!waId) continue;
          const kind =
            by === 'business' || (!by && p.input != null) ? 'removed' : 'left';
          const result = await participant(groupId, waId, kind);
          if (result !== 'unknown') {
            await notify(
              await managers(r),
              'deal_room_update',
              r,
              kind === 'left'
                ? 'A participant left the deal room'
                : 'A participant was removed from the deal room',
              { event: `participant_${kind}`, wa_id: waId }
            );
          }
        }
        return;
      }
      case 'group_join_request_created': {
        const joinRequestId = str(event.join_request_id);
        const waId = digits(event.wa_id);
        if (!joinRequestId || !waId) return;
        const decision = await rpc('deal_room_record_join_request', {
          p_account: accountId,
          p_group_id: groupId,
          p_join_request_id: joinRequestId,
          p_wa_id: waId,
        });
        if (decision === 'auto_approved') {
          await approveJoinRequests({
            groupId,
            accessToken: args.accessToken,
            joinRequestIds: [joinRequestId],
          });
        } else if (decision === 'pending') {
          await notify(
            await managers(r),
            'deal_room_join_request',
            r,
            'Someone asked to join a deal room',
            { join_request_id: joinRequestId, wa_id: waId }
          );
        }
        return;
      }
      case 'group_join_request_revoked': {
        const { error } = await db.from('deal_room_audit').insert({
          room_id: r.id,
          account_id: accountId,
          actor_id: null,
          action: 'join_request_revoked',
          detail: {
            join_request_id: str(event.join_request_id),
            wa_id: digits(event.wa_id),
          },
        });
        if (error) throw new Error(`audit failed: ${error.message}`);
        return;
      }
      case 'group_suspend':
      case 'group_suspend_cleared': {
        const suspended = type === 'group_suspend';
        await rpc('deal_room_set_status', {
          p_room: r.id,
          p_status: suspended ? 'suspended' : 'open',
          p_reason: suspended ? 'suspended by WhatsApp' : null,
        });
        await notify(
          [...(await managers(r)), ...(await workspaceAdminIds(db, accountId))],
          'deal_room_update',
          r,
          suspended
            ? 'WhatsApp suspended a deal room'
            : 'A deal room is no longer suspended',
          { event: type }
        );
        return;
      }
      case 'group_settings_update': {
        const settings = parseGroupSettings(event);
        if (!settings) {
          console.info('[deal-rooms] group settings update: nothing to apply');
          return;
        }
        await rpc('deal_room_apply_settings', {
          p_account: accountId,
          p_group_id: groupId,
          p_settings: settings,
        });
        return;
      }
      default:
        // Anything new: logged only.
        console.info(`[deal-rooms] group event "${type}" logged only`);
    }
  }

  function arr(value: unknown): Json[] {
    return (Array.isArray(value) ? value : []).map(obj);
  }

  async function participant(groupId: string, waId: string, event: string) {
    return rpc('deal_room_participant_event', {
      p_account: accountId,
      p_group_id: groupId,
      p_wa_id: waId,
      p_event: event,
    });
  }

  async function inbound(m: Json): Promise<void> {
    const groupId = str(m.group_id)!;
    const id = str(m.id);
    const from = digits(m.from);
    if (!id || !from) return;
    const r = await room(groupId);
    const type = str(m.type) ?? 'unsupported';
    const rawMedia = MEDIA_TYPES.has(type) ? obj(m[type]) : null;
    let body = str(obj(m.text).body) ?? str(rawMedia?.caption);
    let media: Json | null = null;

    if (rawMedia) {
      const { data: seen } = await db
        .from('group_messages')
        .select('id')
        .eq('wa_message_id', id)
        .maybeSingle();
      if (seen) return; // redelivery: the file is already saved
      media = await saveMedia(r, id, type, rawMedia);
    } else if (type !== 'text') {
      body = null;
    }

    // A STOP seen before (a redelivery the edge screen let through)
    // removes and stamps again, but writes no second opt-out record.
    const stop = type === 'text' && isOptOutText(body);
    const fresh = stop && !(await seenMessage(id));

    await rpc('deal_room_record_message', {
      p_account: accountId,
      p_group_id: groupId,
      p_direction: 'in',
      p_type: rawMedia || type === 'text' ? type : 'unsupported',
      p_wa_message_id: id,
      p_sender_wa_id: from,
      p_body: body,
      p_media: media,
    });

    if (stop) await optOut(r, groupId, from, fresh);
  }

  async function seenMessage(waMessageId: string): Promise<boolean> {
    const { data } = await db
      .from('group_messages')
      .select('id')
      .eq('account_id', accountId)
      .eq('wa_message_id', waMessageId)
      .maybeSingle();
    return data != null;
  }

  // "Saved to the deal file automatically": the bytes go to the private
  // deal-files bucket with a deal_files row. Best-effort: a failure is
  // kept on the message instead of losing it.
  async function saveMedia(
    r: Room,
    messageId: string,
    type: string,
    raw: Json
  ): Promise<Json> {
    const media: Json = {
      id: str(raw.id),
      mime_type: str(raw.mime_type),
      filename: str(raw.filename),
    };
    try {
      const mediaId = str(raw.id);
      if (!mediaId) throw new Error('no media id');
      const { url, mimeType } = await getMediaUrl({
        mediaId,
        accessToken: args.accessToken,
      });
      const { buffer } = await downloadMedia({
        downloadUrl: url,
        accessToken: args.accessToken,
      });
      const safe = (s: string) =>
        s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
      const name = str(raw.filename) ?? `${type}-${messageId.slice(-12)}`;
      const path = `account-${accountId}/room-${r.id}/${safe(messageId)}-${safe(name)}`;
      const { error: upErr } = await db.storage
        .from(DEAL_FILES_BUCKET)
        .upload(path, buffer, { contentType: mimeType, upsert: true });
      if (upErr) throw new Error(`upload failed: ${upErr.message}`);
      const { data: file, error } = await db
        .from('deal_files')
        .insert({
          account_id: accountId,
          deal_id: r.deal_id,
          room_id: r.id,
          storage_path: path,
          name: name.slice(0, 255),
          mime: mimeType,
          bytes: buffer.length,
          source: 'deal_room_media',
          ref_type: 'group_message',
          ref_id: messageId,
        })
        .select('id')
        .single();
      if (error) throw new Error(`deal file row failed: ${error.message}`);
      media.storage_path = path;
      media.deal_file_id = (file as { id: string }).id;
    } catch (err) {
      console.error('[deal-rooms] saving group media failed:', err);
      media.error = err instanceof Error ? err.message : String(err);
    }
    return media;
  }

  async function optOut(
    r: Room,
    groupId: string,
    waId: string,
    fresh: boolean
  ): Promise<void> {
    const { data: p } = await db
      .from('deal_room_participants')
      .select('contact_id')
      .eq('room_id', r.id)
      .or(`wa_id.eq.${waId},phone.eq.${waId}`)
      .limit(1)
      .maybeSingle();
    let contactId =
      (p as { contact_id: string | null } | null)?.contact_id ?? null;
    if (!contactId) {
      // Not a listed person's contact: the account's contact on this
      // number, whatever form its phone was saved in.
      const variants = phoneVariants(waId);
      const { data: rows, error } = await db
        .from('contacts')
        .select('id, phone_normalized')
        .eq('account_id', accountId)
        .in('phone_normalized', variants)
        .limit(20);
      if (error)
        console.error('[deal-rooms] opt-out contact lookup failed:', error);
      contactId = pickContactByPhone(rows, variants);
    }
    // markOptedOut answers false for a failed write and for a contact
    // stamped before alike; only the stamp itself tells them apart.
    const optedOut =
      contactId !== null &&
      ((await markOptedOut(db, { accountId, contactId })) ||
        (await hasOptedOut(contactId)));
    if (fresh) {
      // The room's record of the STOP; its audit trigger (migration 100)
      // posts the Team note. Written before the removal at Meta, so the
      // removal's own webhook finds it and adds no second note.
      // Fail-open: the removal and stamp stand.
      const { error } = await db.from('deal_room_audit').insert({
        room_id: r.id,
        account_id: accountId,
        actor_id: null,
        action: 'participant_opted_out',
        detail: {
          wa_id: waId,
          opted_out: optedOut,
          contact_found: contactId !== null,
        },
      });
      if (error) console.error('[deal-rooms] opt-out record failed:', error);
    }
    try {
      await removeParticipants({
        groupId,
        accessToken: args.accessToken,
        participants: [waId],
      });
    } catch (err) {
      console.error(
        '[deal-rooms] removing an opted-out participant failed:',
        err
      );
    }
    await rpc('deal_room_record_message', {
      p_account: accountId,
      p_group_id: groupId,
      p_direction: 'out',
      p_type: 'system',
      p_body: `+${waId} asked to stop and was removed from the group.`,
      p_status: 'sent',
    });
  }

  async function hasOptedOut(contactId: string): Promise<boolean> {
    const { data, error } = await db
      .from('contacts')
      .select('opted_out_at')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) console.error('[deal-rooms] opt-out stamp check failed:', error);
    return (
      (data as { opted_out_at: string | null } | null)?.opted_out_at != null
    );
  }

  async function receipt(s: Json): Promise<void> {
    const id = str(s.id);
    const status = str(s.status);
    // Meta's pages spell the participant field both ways.
    const who =
      digits(s.recipient_participant_id) ?? digits(s.participant_recipient_id);
    if (!id || !status) return;
    if (status === 'delivered' || status === 'read') {
      if (who)
        await rpc('deal_room_record_receipt', {
          p_account: accountId,
          p_wa_message_id: id,
          p_participant_wa_id: who,
          p_status: status,
        });
    } else if (status === 'failed') {
      // A group-wide failure names no participant: the group stands in.
      const key = who ?? str(s.recipient_id);
      if (key)
        await rpc('deal_room_record_receipt', {
          p_account: accountId,
          p_wa_message_id: id,
          p_participant_wa_id: key,
          p_status: 'failed',
        });
    }
  }
}
