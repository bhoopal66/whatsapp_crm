/**
 * Deal rooms — what staff do to a live room (module 014c, migration 088):
 * send to the group, decide join requests, remove a person, hand out or
 * reset the invite link, close. Server-only, on the service role: every
 * route asks the caller's permission function (as the caller) first.
 *
 * The rules held here:
 *  - Everyone in a room sees every message, so this is the only way a
 *    message reaches a group. Team notes are internal chat and never
 *    pass through it.
 *  - Free text and files only while the group's 24-hour window is open
 *    (`window_until`, reopened by any member's message); outside it,
 *    templates only (Meta refuses one that is not approved).
 *  - A file sent to the group is kept in the deal file, as an inbound
 *    one is (`deal_files`, source `deal_room_media`).
 *  - A sent group message is final: nothing here edits or deletes one.
 *  - A removed person cannot rejoin through the invite link (Meta).
 */

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { MetaError } from '@/lib/whatsapp/meta-api';
import {
  GROUP_MAX_PARTICIPANTS,
  approveJoinRequests,
  deleteGroup,
  getInviteLink,
  rejectJoinRequests,
  removeParticipants,
  resetInviteLink,
  sendGroupMedia,
  sendGroupTemplate,
  sendGroupText,
} from '@/lib/whatsapp/meta-groups';
import { toPublicSupabaseUrl } from '@/lib/supabase/urls';

import {
  ROOM_MEDIA_CAPTION_MAX,
  checkRoomMedia,
  roomMediaPath,
  type RoomMediaKind,
} from './room-media';
import { metaChannel } from './shared';
import { saveTranscript } from './transcript';

export interface Fail {
  ok: false;
  status: number;
  /** A stable machine code for the UI (`window_closed`, …). */
  code: string;
  error: string;
  detail?: Record<string, unknown>;
}

export function fail(
  status: number,
  code: string,
  error: string,
  detail?: Record<string, unknown>
): Fail {
  return { ok: false, status, code, error, ...(detail ? { detail } : {}) };
}

export interface LiveRoom {
  id: string;
  account_id: string;
  channel_id: string;
  created_by: string | null;
  subject: string;
  status: string;
  wa_group_id: string | null;
  whatsapp_config_id: string | null;
  window_until: string | null;
  deal_id: string | null;
  created_at: string;
  close_reason: string | null;
}

const ROOM_COLUMNS =
  'id, account_id, channel_id, created_by, subject, status, wa_group_id, ' +
  'whatsapp_config_id, window_until, deal_id, created_at, close_reason';

export async function loadRoom(
  db: SupabaseClient,
  roomId: string
): Promise<LiveRoom | null> {
  const { data, error } = await db
    .from('deal_rooms')
    .select(ROOM_COLUMNS)
    .eq('id', roomId)
    .maybeSingle();
  if (error) throw new Error(`room lookup failed: ${error.message}`);
  return (data as LiveRoom | null) ?? null;
}

/** The group's 24-hour window: open while `window_until` is ahead. */
export function isWindowOpen(
  windowUntil: string | null,
  now = Date.now()
): boolean {
  const until = windowUntil ? Date.parse(windowUntil) : NaN;
  return Number.isFinite(until) && until > now;
}

interface GroupAccess {
  phoneNumberId: string;
  accessToken: string;
  groupId: string;
}

async function groupAccess(
  db: SupabaseClient,
  room: LiveRoom
): Promise<GroupAccess | Fail> {
  if (!room.wa_group_id) {
    return fail(409, 'group_not_created', 'The group is not created yet');
  }
  const channel = await metaChannel(
    db,
    room.account_id,
    room.whatsapp_config_id
  );
  if (!channel) {
    return fail(
      409,
      'number_disconnected',
      "The room's Meta number is not connected"
    );
  }
  return {
    phoneNumberId: channel.phoneNumberId,
    accessToken: channel.accessToken,
    groupId: room.wa_group_id,
  };
}

const isFail = (v: unknown): v is Fail =>
  !!v && typeof v === 'object' && (v as Fail).ok === false;

/** A Meta refusal in words; anything that is not a MetaError rethrows. */
export function metaFailure(err: unknown): Fail {
  if (!(err instanceof MetaError)) throw err;
  if (err.isGroupNotReady) {
    return fail(
      409,
      'group_not_ready',
      'Nobody has joined the group yet: WhatsApp accepts group messages once someone has'
    );
  }
  if (err.isGroupSuspended) {
    return fail(
      409,
      'group_suspended',
      'WhatsApp suspended this group: nothing can be done in it until that is cleared'
    );
  }
  if (err.isGroupUnknown) {
    return fail(409, 'group_gone', 'WhatsApp no longer knows this group');
  }
  if (err.isOutsideServiceWindow) {
    return fail(
      409,
      'window_closed',
      "The group's 24-hour window is closed: send an approved template"
    );
  }
  if (err.isTemplateError) {
    return fail(
      422,
      'template_rejected',
      `WhatsApp refused the template: ${err.message}`
    );
  }
  if (err.isGroupRateLimited || err.isRateLimited) {
    return fail(
      429,
      'rate_limited',
      'Too many WhatsApp requests: try again shortly'
    );
  }
  return fail(
    502,
    'meta_error',
    `WhatsApp refused the request: ${err.message}`
  );
}

async function audit(
  db: SupabaseClient,
  room: LiveRoom,
  actorId: string | null,
  action: string,
  detail: Record<string, unknown>
): Promise<void> {
  const { error } = await db.from('deal_room_audit').insert({
    room_id: room.id,
    account_id: room.account_id,
    actor_id: actorId,
    action,
    detail,
  });
  if (error) console.error('[deal-rooms] audit failed:', error.message);
}

async function setStatus(
  db: SupabaseClient,
  roomId: string,
  status: string,
  reason: string | null
): Promise<void> {
  const { error } = await db.rpc('deal_room_set_status', {
    p_room: roomId,
    p_status: status,
    p_reason: reason,
  });
  if (error) throw new Error(`status change failed: ${error.message}`);
}

function openRoom(room: LiveRoom | null): LiveRoom | Fail {
  if (!room) return fail(404, 'not_found', 'Deal room not found');
  if (room.status !== 'open') {
    return fail(409, 'room_not_open', `The deal room is ${room.status}`);
  }
  return room;
}

// ============================================================
// Sending to the group
// ============================================================

export type PostInput =
  | { kind: 'text'; text: string }
  | {
      kind: 'media';
      mediaKind: RoomMediaKind;
      bytes: Uint8Array;
      mime: string;
      fileName: string;
      caption: string | null;
    }
  | {
      kind: 'template';
      templateName: string;
      language: string;
      params: string[];
    };

const TEXT_MAX = 4096;
const PARAMS_MAX = 20;

export function parsePostBody(
  body: unknown
): { ok: true; value: PostInput } | { ok: false; error: string } {
  const b =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  if (typeof b.text === 'string' && b.templateName === undefined) {
    const text = b.text.trim();
    if (!text) return { ok: false, error: 'The message is empty' };
    if (text.length > TEXT_MAX) {
      return {
        ok: false,
        error: `A message is at most ${TEXT_MAX} characters`,
      };
    }
    return { ok: true, value: { kind: 'text', text } };
  }
  if (typeof b.templateName === 'string' && b.text === undefined) {
    const templateName = b.templateName.trim();
    const language = typeof b.language === 'string' ? b.language.trim() : '';
    if (!/^[a-z0-9_]{1,512}$/.test(templateName)) {
      return { ok: false, error: 'Unknown template name' };
    }
    if (!/^[a-z]{2,3}(_[A-Z]{2,3})?$/.test(language)) {
      return {
        ok: false,
        error: 'A template needs its language (e.g. en or en_US)',
      };
    }
    const raw = b.params ?? [];
    if (
      !Array.isArray(raw) ||
      raw.length > PARAMS_MAX ||
      !raw.every((p) => typeof p === 'string' && p.trim() && p.length <= 1024)
    ) {
      return {
        ok: false,
        error: `params must be up to ${PARAMS_MAX} non-empty strings`,
      };
    }
    return {
      ok: true,
      value: {
        kind: 'template',
        templateName,
        language,
        params: raw as string[],
      },
    };
  }
  return {
    ok: false,
    error: 'Send { text } or { templateName, language, params? }',
  };
}

/**
 * A file from the composer's multipart body: `file` plus an optional
 * `caption`. The bytes are read here, after the type and size checks.
 */
export async function parseMediaForm(
  form: FormData | null
): Promise<
  { ok: true; value: PostInput } | { ok: false; error: string; code: string }
> {
  const file = form?.get('file');
  if (!file || typeof file === 'string') {
    return { ok: false, error: 'Attach a file', code: 'invalid' };
  }
  const check = checkRoomMedia(file);
  if (!check.ok) {
    return check.code === 'media_type'
      ? {
          ok: false,
          error: 'Only images (JPEG, PNG) and documents can be sent',
          code: check.code,
        }
      : {
          ok: false,
          error: `This file is over the ${Math.round(check.maxBytes / 1024 / 1024)} MB limit`,
          code: check.code,
        };
  }
  const raw = form?.get('caption');
  const caption = typeof raw === 'string' ? raw.trim() : '';
  if (caption.length > ROOM_MEDIA_CAPTION_MAX) {
    return {
      ok: false,
      error: `A caption is at most ${ROOM_MEDIA_CAPTION_MAX} characters`,
      code: 'invalid',
    };
  }
  return {
    ok: true,
    value: {
      kind: 'media',
      mediaKind: check.kind,
      bytes: new Uint8Array(await file.arrayBuffer()),
      mime: file.type.split(';')[0].trim().toLowerCase(),
      fileName: (file.name || 'file').slice(0, 255),
      caption: caption || null,
    },
  };
}

const DEAL_FILES_BUCKET = 'deal-files';
/** Meta fetches a linked file when the message is sent. */
const MEDIA_LINK_SECONDS = 600;

interface StagedMedia {
  path: string;
  link: string;
}

/**
 * The file goes to the private deal-files bucket first, and Meta gets a
 * short-lived signed link to it, on the public origin (the server's own
 * Supabase URL may be an internal one Meta cannot reach). The link is a
 * bearer URL: it is handed to Meta and never logged or stored.
 */
async function stageMedia(
  db: SupabaseClient,
  room: LiveRoom,
  input: Extract<PostInput, { kind: 'media' }>
): Promise<StagedMedia | Fail> {
  const path = roomMediaPath(room.account_id, room.id, input.fileName);
  const bucket = db.storage.from(DEAL_FILES_BUCKET);
  const { error: upErr } = await bucket.upload(path, input.bytes, {
    contentType: input.mime,
    upsert: false,
  });
  if (upErr) {
    console.error('[deal-rooms] media upload failed:', upErr.message);
    return fail(502, 'media_upload', 'The file could not be stored');
  }
  const { data, error } = await bucket.createSignedUrl(
    path,
    MEDIA_LINK_SECONDS
  );
  if (error || !data?.signedUrl) {
    console.error('[deal-rooms] media link failed:', error?.message);
    await dropStaged(db, path);
    return fail(502, 'media_upload', 'The file could not be stored');
  }
  return { path, link: toPublicSupabaseUrl(data.signedUrl) };
}

/** Best-effort: a file WhatsApp never received leaves nothing behind. */
async function dropStaged(db: SupabaseClient, path: string): Promise<void> {
  const { error } = await db.storage.from(DEAL_FILES_BUCKET).remove([path]);
  if (error) console.error('[deal-rooms] media cleanup failed:', error.message);
}

/**
 * The sent file as a deal_files row (as webhook.ts files an inbound one)
 * and the message's `media`. Best-effort: the message went out, so a
 * failure is kept on the message rather than failing the send.
 */
async function fileSentMedia(
  db: SupabaseClient,
  room: LiveRoom,
  input: Extract<PostInput, { kind: 'media' }>,
  staged: StagedMedia,
  waMessageId: string,
  userId: string
): Promise<Record<string, unknown>> {
  const media: Record<string, unknown> = {
    id: null,
    mime_type: input.mime,
    filename: input.fileName,
    storage_path: staged.path,
  };
  const { data, error } = await db
    .from('deal_files')
    .insert({
      account_id: room.account_id,
      deal_id: room.deal_id,
      room_id: room.id,
      storage_path: staged.path,
      name: input.fileName,
      mime: input.mime,
      bytes: input.bytes.byteLength,
      source: 'deal_room_media',
      ref_type: 'group_message',
      ref_id: waMessageId,
      created_by: userId,
    })
    .select('id')
    .single();
  if (error) {
    console.error('[deal-rooms] deal file row failed:', error.message);
    media.error = `deal file row failed: ${error.message}`;
  } else {
    media.deal_file_id = (data as { id?: string } | null)?.id ?? null;
  }
  return media;
}

export async function sendRoomMessage(
  db: SupabaseClient,
  args: { roomId: string; userId: string; input: PostInput }
): Promise<{ ok: true; id: string | null; waMessageId: string } | Fail> {
  const room = openRoom(await loadRoom(db, args.roomId));
  if (isFail(room)) return room;
  const { input } = args;
  // Before anything is stored: a file is free-form, like text.
  if (input.kind !== 'template' && !isWindowOpen(room.window_until)) {
    return fail(
      409,
      'window_closed',
      "The group's 24-hour window is closed: only an approved template can be sent until a member writes"
    );
  }
  const access = await groupAccess(db, room);
  if (isFail(access)) return access;
  let staged: StagedMedia | null = null;
  if (input.kind === 'media') {
    const s = await stageMedia(db, room, input);
    if (isFail(s)) return s;
    staged = s;
  }

  let waMessageId: string;
  try {
    const sent =
      input.kind === 'text'
        ? await sendGroupText({ ...access, text: input.text })
        : input.kind === 'media'
          ? await sendGroupMedia({
              ...access,
              kind: input.mediaKind,
              link: staged!.link,
              ...(input.caption ? { caption: input.caption } : {}),
              filename: input.fileName,
            })
          : await sendGroupTemplate({
              ...access,
              templateName: input.templateName,
              language: input.language,
              components: input.params.length
                ? [
                    {
                      type: 'body',
                      parameters: input.params.map((text) => ({
                        type: 'text',
                        text,
                      })),
                    },
                  ]
                : undefined,
            });
    waMessageId = sent.messageId;
  } catch (err) {
    if (staged) await dropStaged(db, staged.path);
    if (err instanceof MetaError && err.isGroupSuspended) {
      await setStatus(db, room.id, 'suspended', 'suspended by WhatsApp').catch(
        (e: Error) => console.error('[deal-rooms] suspend failed:', e.message)
      );
    }
    return metaFailure(err);
  }

  const media =
    input.kind === 'media'
      ? await fileSentMedia(db, room, input, staged!, waMessageId, args.userId)
      : null;
  const { data, error } = await db.rpc('deal_room_record_message', {
    p_account: room.account_id,
    p_group_id: access.groupId,
    p_direction: 'out',
    p_type: input.kind === 'media' ? input.mediaKind : input.kind,
    p_wa_message_id: waMessageId,
    p_sender_wa_id: null,
    p_body:
      input.kind === 'text'
        ? input.text
        : input.kind === 'media'
          ? input.caption
          : null,
    p_media: media,
    p_template_name: input.kind === 'template' ? input.templateName : null,
    p_staff_user_id: args.userId,
    p_status: 'sent',
    p_error: null,
  });
  // The message went out; a failed record must not invite a second send.
  if (error) console.error('[deal-rooms] message not recorded:', error.message);
  return { ok: true, id: (data as string | null) ?? null, waMessageId };
}

// ============================================================
// Join requests
// ============================================================

export interface JoinDecisionSummary {
  approved: string[];
  rejected: string[];
  failed: { joinRequestId: string; error: string }[];
  /** Not a pending request of this room (unknown, or decided already). */
  skipped: string[];
}

export function parseJoinDecisionBody(
  body: unknown
):
  | { ok: true; approve: string[]; reject: string[] }
  | { ok: false; error: string } {
  const b =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const list = (v: unknown): string[] | null =>
    v === undefined
      ? []
      : Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim())
        ? [...new Set(v as string[])]
        : null;
  const approve = list(b.approve);
  const reject = list(b.reject);
  if (!approve || !reject) {
    return {
      ok: false,
      error: 'approve and reject are lists of join request ids',
    };
  }
  const total = approve.length + reject.length;
  if (total === 0 || total > 50) {
    return { ok: false, error: 'Decide 1 to 50 join requests at a time' };
  }
  if (approve.some((id) => reject.includes(id))) {
    return {
      ok: false,
      error: 'A join request cannot be approved and rejected',
    };
  }
  return { ok: true, approve, reject };
}

export async function decideJoinRequests(
  db: SupabaseClient,
  args: { roomId: string; userId: string; approve: string[]; reject: string[] }
): Promise<({ ok: true } & JoinDecisionSummary) | Fail> {
  const room = openRoom(await loadRoom(db, args.roomId));
  if (isFail(room)) return room;
  const access = await groupAccess(db, room);
  if (isFail(access)) return access;

  const ids = [...args.approve, ...args.reject];
  const { data, error } = await db
    .from('deal_room_join_requests')
    .select('join_request_id, decision')
    .eq('room_id', room.id)
    .in('join_request_id', ids);
  if (error) throw new Error(`join request lookup failed: ${error.message}`);
  const pending = new Set(
    ((data ?? []) as { join_request_id: string; decision: string }[])
      .filter((r) => r.decision === 'pending')
      .map((r) => r.join_request_id)
  );
  const out: JoinDecisionSummary = {
    approved: [],
    rejected: [],
    failed: [],
    skipped: ids.filter((id) => !pending.has(id)),
  };

  const batches = [
    ['approved', args.approve, approveJoinRequests],
    ['rejected', args.reject, rejectJoinRequests],
  ] as const;
  for (const [decision, wanted, call] of batches) {
    const list = wanted.filter((id) => pending.has(id));
    if (list.length === 0) continue;
    try {
      const result = await call({
        groupId: access.groupId,
        accessToken: access.accessToken,
        joinRequestIds: list,
      });
      const failedIds = new Set(result.failed.map((f) => f.joinRequestId));
      // Meta's success body is not documented: no list means all but the failures.
      const done = result.done.length
        ? list.filter((id) => result.done.includes(id))
        : list.filter((id) => !failedIds.has(id));
      for (const f of result.failed) {
        out.failed.push({
          joinRequestId: f.joinRequestId,
          error: f.message ?? `WhatsApp error ${f.code ?? 'unknown'}`,
        });
      }
      if (done.length === 0) continue;
      const { error: updErr } = await db
        .from('deal_room_join_requests')
        .update({
          decision,
          decided_by: args.userId,
          decided_at: new Date().toISOString(),
        })
        .eq('room_id', room.id)
        .eq('decision', 'pending')
        .in('join_request_id', done);
      if (updErr)
        console.error('[deal-rooms] decision not recorded:', updErr.message);
      out[decision].push(...done);
    } catch (err) {
      const f = metaFailure(err);
      for (const id of list)
        out.failed.push({ joinRequestId: id, error: f.error });
    }
  }
  await audit(db, room, args.userId, 'join_requests_decided', {
    approved: out.approved,
    rejected: out.rejected,
    failed: out.failed.map((f) => f.joinRequestId),
  });
  return { ok: true, ...out };
}

// ============================================================
// Removing a person
// ============================================================

export const REMOVED_WARNING =
  'A removed person cannot rejoin through the invite link.';

export async function removeRoomParticipant(
  db: SupabaseClient,
  args: { roomId: string; participantId: string; userId: string }
): Promise<{ ok: true; participantId: string; warning: string } | Fail> {
  const room = openRoom(await loadRoom(db, args.roomId));
  if (isFail(room)) return room;
  const { data, error } = await db
    .from('deal_room_participants')
    .select('id, role, status, wa_id, phone')
    .eq('id', args.participantId)
    .eq('room_id', room.id)
    .maybeSingle();
  if (error) throw new Error(`participant lookup failed: ${error.message}`);
  const p = data as {
    id: string;
    role: string | null;
    status: string;
    wa_id: string | null;
    phone: string | null;
  } | null;
  if (!p) return fail(404, 'not_found', 'Participant not found in this room');
  if (p.role === 'business') {
    return fail(
      409,
      'business_number',
      'The business number cannot be removed'
    );
  }
  const user = p.wa_id ?? p.phone;
  if (p.status !== 'joined' || !user) {
    return fail(409, 'not_in_group', 'This person is not in the group');
  }
  const access = await groupAccess(db, room);
  if (isFail(access)) return access;
  try {
    await removeParticipants({
      groupId: access.groupId,
      accessToken: access.accessToken,
      participants: [user],
    });
  } catch (err) {
    return metaFailure(err);
  }
  const { error: evErr } = await db.rpc('deal_room_participant_event', {
    p_account: room.account_id,
    p_group_id: access.groupId,
    p_wa_id: user,
    p_event: 'removed',
  });
  // The webhook records the removal too; this is the early copy.
  if (evErr) console.error('[deal-rooms] removal not recorded:', evErr.message);
  await audit(db, room, args.userId, 'remove_requested', {
    participant_id: p.id,
  });
  return { ok: true, participantId: p.id, warning: REMOVED_WARNING };
}

// ============================================================
// The invite link (never stored in clear: only its hash)
// ============================================================

export async function roomInviteLink(
  db: SupabaseClient,
  args: { roomId: string; userId: string; reset: boolean }
): Promise<{ ok: true; inviteLink: string } | Fail> {
  const room = openRoom(await loadRoom(db, args.roomId));
  if (isFail(room)) return room;
  const access = await groupAccess(db, room);
  if (isFail(access)) return access;
  let inviteLink: string;
  try {
    const auth = { groupId: access.groupId, accessToken: access.accessToken };
    ({ inviteLink } = args.reset
      ? await resetInviteLink(auth)
      : await getInviteLink(auth));
  } catch (err) {
    return metaFailure(err);
  }
  if (args.reset) {
    const { error } = await db
      .from('deal_rooms')
      .update({
        invite_link_hash: createHash('sha256').update(inviteLink).digest('hex'),
      })
      .eq('id', room.id);
    if (error)
      console.error('[deal-rooms] link hash not stored:', error.message);
    await audit(db, room, args.userId, 'invite_link_reset', {});
  }
  return { ok: true, inviteLink };
}

// ============================================================
// Closing
// ============================================================

export async function closeRoom(
  db: SupabaseClient,
  args: { roomId: string; userId: string; reason: string | null }
): Promise<{ ok: true; status: 'closed'; transcriptFileId: string } | Fail> {
  const room = await loadRoom(db, args.roomId);
  if (!room) return fail(404, 'not_found', 'Deal room not found');
  if (room.status === 'closed') {
    return fail(409, 'already_closed', 'The deal room is already closed');
  }
  if (room.status === 'creating') {
    return fail(
      409,
      'room_creating',
      'The group is still being created: close the room once it exists or has failed'
    );
  }
  const retry = room.status === 'closing';
  await setStatus(db, room.id, 'closing', args.reason);
  await audit(db, room, args.userId, 'close_requested', {
    reason: args.reason,
    retry,
  });

  const stuck = async (step: string, message: string): Promise<Fail> => {
    const { error } = await db
      .from('deal_rooms')
      .update({ last_error: `Closing stopped at ${step}: ${message}` })
      .eq('id', room.id);
    if (error)
      console.error('[deal-rooms] last_error not stored:', error.message);
    return fail(
      502,
      'close_incomplete',
      `The room is still closing (${step} failed: ${message}). Close it again to finish.`,
      { status: 'closing', step }
    );
  };
  const metaMessage = (err: unknown) =>
    err instanceof MetaError
      ? metaFailure(err).error
      : err instanceof Error
        ? err.message
        : String(err);

  let transcriptFileId: string;
  try {
    transcriptFileId = (await saveTranscript(db, room, args.userId, 'close'))
      .id;
  } catch (err) {
    return stuck(
      'transcript',
      err instanceof Error ? err.message : String(err)
    );
  }

  if (room.wa_group_id) {
    const access = await groupAccess(db, room);
    if (isFail(access)) return stuck('remove', access.error);
    const { data, error } = await db
      .from('deal_room_participants')
      .select('id, role, status, wa_id, phone')
      .eq('room_id', room.id);
    if (error) return stuck('remove', error.message);
    const people = (
      (data ?? []) as {
        role: string | null;
        status: string;
        wa_id: string | null;
        phone: string | null;
      }[]
    )
      .filter((p) => p.role !== 'business' && p.status === 'joined')
      .map((p) => p.wa_id ?? p.phone)
      .filter((u): u is string => !!u);
    let gone = false;
    for (let i = 0; i < people.length && !gone; i += GROUP_MAX_PARTICIPANTS) {
      const batch = people.slice(i, i + GROUP_MAX_PARTICIPANTS);
      try {
        await removeParticipants({
          groupId: access.groupId,
          accessToken: access.accessToken,
          participants: batch,
        });
      } catch (err) {
        // Already deleted at WhatsApp: nothing left to remove.
        if (err instanceof MetaError && err.isGroupUnknown) {
          gone = true;
          break;
        }
        return stuck('remove', metaMessage(err));
      }
      for (const user of batch) {
        const { error: evErr } = await db.rpc('deal_room_participant_event', {
          p_account: room.account_id,
          p_group_id: access.groupId,
          p_wa_id: user,
          p_event: 'removed',
        });
        if (evErr)
          console.error('[deal-rooms] removal not recorded:', evErr.message);
      }
    }
    if (!gone) {
      try {
        await deleteGroup({
          groupId: access.groupId,
          accessToken: access.accessToken,
        });
      } catch (err) {
        if (!(err instanceof MetaError && err.isGroupUnknown)) {
          return stuck('delete', metaMessage(err));
        }
      }
    }
  }

  const { error: clearErr } = await db
    .from('deal_rooms')
    .update({ last_error: null })
    .eq('id', room.id);
  if (clearErr)
    console.error('[deal-rooms] last_error not cleared:', clearErr.message);
  await setStatus(db, room.id, 'closed', args.reason);
  return { ok: true, status: 'closed', transcriptFileId };
}

// ============================================================
// Cancelling a room still being created
// ============================================================

/** `last_error` of a room cancelled without a reason. */
export const CANCELLED_NOTE = 'Cancelled before WhatsApp created the group';

/**
 * Stop a room still `creating` (096): `failed`, stamped cancelled, with
 * the canceller in its audit trail. A group that arrives later is
 * discarded, never opened. A room in any other state is left as it is:
 * 409 `room_not_creating` with its status (a group that arrived
 * meanwhile opened it; close it instead).
 */
export async function cancelCreatingRoom(
  db: SupabaseClient,
  args: { roomId: string; userId: string; reason: string | null }
): Promise<{ ok: true; status: 'failed' } | Fail> {
  const { data, error } = await db.rpc('deal_room_cancel_creation', {
    p_room: args.roomId,
    p_actor: args.userId,
    p_reason: args.reason ? `Cancelled: ${args.reason}` : CANCELLED_NOTE,
  });
  if (error) {
    if ((error as { code?: string }).code === 'P0002') {
      return fail(404, 'not_found', 'Deal room not found');
    }
    throw new Error(`cancel failed: ${error.message}`);
  }
  if (data === 'cancelled') return { ok: true, status: 'failed' };
  return fail(
    409,
    'room_not_creating',
    `The deal room is ${String(data)}: only a room still being created can be cancelled`,
    { status: data }
  );
}
