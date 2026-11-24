/**
 * OpenWA gateway group API, mapped onto wacrm's existing group shapes
 * (the `Whapi*` group types), so the groups facade can serve an OpenWA
 * number with the same domain objects it builds for Whapi.
 *
 * Route rule: every call addressed to one group (`/groups/:groupId…`),
 * and the invite-code lookups, is sent with `route: 'message'`. A 404
 * there means "no such group / code", never "the session was removed",
 * so `OpenWAError.isSessionNotFound` stays false for it. Creating and
 * listing groups keep `route: 'session'`: a 404 there is the session.
 *
 * No failure-key mapping lives here; the facade decides what an
 * `OpenWAError` means to the person.
 */
import { OpenWAError, openwaRequest } from './openwa-api';
import type {
  WhapiGroup,
  WhapiGroupParticipant,
  WhapiGroupPolicy,
  WhapiGroupPreview,
  WhapiGroupSetting,
  WhapiGroupSettings,
  WhapiIdentity,
  WhapiJoinRequest,
} from './whapi-api';

export interface OpenWAGroupCreds {
  sessionId: string;
  apiKey: string;
  timeoutMs?: number;
}

/** A group operation OpenWA cannot perform (e.g. join approval mode). */
export class OpenWAGroupUnsupportedError extends Error {
  readonly operation: string;
  constructor(operation: string) {
    super(`OpenWA does not support the group operation: ${operation}`);
    this.name = 'OpenWAGroupUnsupportedError';
    this.operation = operation;
  }
}

// ============================================================
// Ids
// ============================================================

const GROUP_ID_RE = /^[0-9-]{10,31}@g\.us$/;

/** wacrm waId (digits, or `<digits>@lid`) → OpenWA participant id. */
export function toOpenWAParticipantId(waId: string): string | null {
  if (/^[0-9]{5,25}$/.test(waId)) return `${waId}@c.us`;
  if (/^[0-9]{5,25}@lid$/.test(waId)) return waId;
  return null;
}

/** OpenWA participant id → identity; `waId` null when not a person id. */
export function fromOpenWAParticipantId(id: string): WhapiIdentity {
  const cus = /^([0-9]{5,25})@(?:c\.us|s\.whatsapp\.net)$/.exec(id);
  if (cus) return { jid: id, waId: cus[1] };
  if (/^[0-9]{5,25}@lid$/.test(id)) return { jid: id, waId: id };
  return { jid: id, waId: null };
}

function participantIds(waIds: string[]): string[] {
  return waIds.map((waId) => {
    const id = toOpenWAParticipantId(waId);
    // Refused before any request, like a missing key in openwaRequest.
    if (!id) {
      throw new OpenWAError(`Invalid participant id: ${waId}`, 400, {
        route: 'message',
      });
    }
    return id;
  });
}

function groupPath(groupId: string, suffix = ''): string {
  return `/groups/${encodeURIComponent(groupId)}${suffix}`;
}

// ============================================================
// Raw shapes
// ============================================================

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** Unix seconds from seconds, milliseconds or an ISO string. */
function unixSeconds(v: unknown): number | null {
  const n = num(v);
  if (n !== null) return n > 1e12 ? Math.floor(n / 1000) : n;
  const s = str(v);
  if (s) {
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

/** An id that may be a string or a whatsapp-web.js `{ _serialized }`. */
function serializedId(v: unknown): string | null {
  return str(v) ?? str(rec(v)._serialized);
}

interface OpenWAGroupSettingsRaw {
  announce?: boolean;
  locked?: boolean;
  memberAddMode?: 'all' | 'admins';
}

interface OpenWAParticipantRaw {
  id: string;
  number?: string;
  name?: string;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
}

interface OpenWAGroupRaw extends OpenWAGroupSettingsRaw {
  id: string;
  name: string;
  description?: string | null;
  owner?: string | null;
  createdAt?: number | null;
  participants?: OpenWAParticipantRaw[];
}

/** One entry of a participant operation's `results`. */
export interface ParticipantResult {
  id: string;
  success: boolean;
  status?: number;
  message?: string;
}

// ============================================================
// Settings
// ============================================================

export function fromOpenWASettings(
  raw: OpenWAGroupSettingsRaw
): WhapiGroupSettings {
  const flag = (v: boolean | undefined): WhapiGroupPolicy | null =>
    v === undefined || v === null ? null : v ? 'admins' : 'anyone';
  return {
    send_messages: flag(raw.announce),
    edit_group_info: flag(raw.locked),
    add_participants:
      raw.memberAddMode === 'admins'
        ? 'admins'
        : raw.memberAddMode === 'all'
          ? 'anyone'
          : null,
    approve_participants: null,
  };
}

/** The `PUT /groups/:gid/settings` body for one setting. */
export function toOpenWASettings(
  setting: WhapiGroupSetting,
  policy: WhapiGroupPolicy
): OpenWAGroupSettingsRaw {
  const admins = policy === 'admins';
  switch (setting) {
    case 'send_messages':
      return { announce: admins };
    case 'edit_group_info':
      return { locked: admins };
    case 'add_participants':
      return { memberAddMode: admins ? 'admins' : 'all' };
    case 'approve_participants':
      throw new OpenWAGroupUnsupportedError('approve_participants');
    default: {
      const never: never = setting;
      throw new OpenWAGroupUnsupportedError(String(never));
    }
  }
}

export async function getSettings(
  creds: OpenWAGroupCreds,
  groupId: string
): Promise<WhapiGroupSettings> {
  const raw = await openwaRequest<OpenWAGroupSettingsRaw>({
    ...creds,
    path: groupPath(groupId, '/settings'),
    route: 'message',
  });
  return fromOpenWASettings(rec(raw));
}

export async function updateSetting(
  creds: OpenWAGroupCreds,
  groupId: string,
  setting: WhapiGroupSetting,
  policy: WhapiGroupPolicy
): Promise<void> {
  const body = toOpenWASettings(setting, policy);
  await openwaRequest<unknown>({
    ...creds,
    path: groupPath(groupId, '/settings'),
    method: 'PUT',
    body,
    route: 'message',
  });
}

// ============================================================
// Groups
// ============================================================

export async function createGroup(
  creds: OpenWAGroupCreds,
  args: { name: string; participants: string[] }
): Promise<{ groupId: string }> {
  const participants = participantIds(args.participants);
  const res = await openwaRequest<{ id?: unknown }>({
    ...creds,
    path: '/groups',
    method: 'POST',
    body: { name: args.name, participants },
    route: 'session',
  });
  const groupId = serializedId(rec(res).id);
  if (!groupId) {
    throw new OpenWAError('OpenWA created a group but sent no id.', 502, {
      route: 'message',
    });
  }
  return { groupId };
}

function toParticipant(p: OpenWAParticipantRaw): WhapiGroupParticipant {
  return {
    ...fromOpenWAParticipantId(p.id),
    role: p.isSuperAdmin ? 'superadmin' : p.isAdmin ? 'admin' : 'member',
  };
}

export async function getGroup(
  creds: OpenWAGroupCreds,
  groupId: string
): Promise<WhapiGroup> {
  const raw = await openwaRequest<OpenWAGroupRaw>({
    ...creds,
    path: groupPath(groupId),
    route: 'message',
  });
  const participants = (Array.isArray(raw.participants) ? raw.participants : [])
    .filter((p) => typeof p?.id === 'string')
    .map(toParticipant);
  const owner = str(raw.owner);
  return {
    id: str(raw.id) ?? groupId,
    name: str(raw.name) ?? '',
    description: str(raw.description),
    participantsCount: participants.length,
    participants,
    createdAt: unixSeconds(raw.createdAt),
    createdBy: owner ? fromOpenWAParticipantId(owner) : null,
    iconUrl: null,
    inviteCode: null,
    settings: fromOpenWASettings(raw),
    suspended: false,
    terminated: false,
  };
}

/** Every `@g.us` group the number is in, id and name only. */
export async function listGroupSummaries(
  creds: OpenWAGroupCreds
): Promise<{ id: string; name: string }[]> {
  const raw = await openwaRequest<unknown>({
    ...creds,
    path: '/groups',
    route: 'session',
  });
  // Read as an empty list, it would have Sync mark every group left.
  if (!Array.isArray(raw)) throw new Error('OpenWA answered no list of groups');
  const out: { id: string; name: string }[] = [];
  for (const item of raw) {
    const r = rec(item);
    const id = serializedId(r.id);
    if (!id || !GROUP_ID_RE.test(id)) continue;
    out.push({ id, name: str(r.name) ?? '' });
  }
  return out;
}

export async function setSubject(
  creds: OpenWAGroupCreds,
  groupId: string,
  subject: string
): Promise<void> {
  await openwaRequest<unknown>({
    ...creds,
    path: groupPath(groupId, '/subject'),
    method: 'PUT',
    body: { subject },
    route: 'message',
  });
}

export async function setDescription(
  creds: OpenWAGroupCreds,
  groupId: string,
  description: string
): Promise<void> {
  await openwaRequest<unknown>({
    ...creds,
    path: groupPath(groupId, '/description'),
    method: 'PUT',
    body: { description },
    route: 'message',
  });
}

export async function leaveGroup(
  creds: OpenWAGroupCreds,
  groupId: string
): Promise<void> {
  await openwaRequest<unknown>({
    ...creds,
    path: groupPath(groupId, '/leave'),
    method: 'POST',
    route: 'message',
  });
}

// ============================================================
// Participants
// ============================================================

async function participantOp(
  creds: OpenWAGroupCreds,
  groupId: string,
  waIds: string[],
  suffix: string,
  method: 'POST' | 'DELETE'
): Promise<ParticipantResult[]> {
  const participants = participantIds(waIds);
  const res = await openwaRequest<{ results?: unknown }>({
    ...creds,
    path: groupPath(groupId, suffix),
    method,
    body: { participants },
    route: 'message',
  });
  const results = rec(res).results;
  if (!Array.isArray(results)) return [];
  return results
    .map(rec)
    .filter((r) => typeof r.id === 'string')
    .map((r) => ({
      id: r.id as string,
      success: r.success === true,
      ...(num(r.status) !== null ? { status: num(r.status)! } : {}),
      ...(str(r.message) ? { message: str(r.message)! } : {}),
    }));
}

export function addParticipants(
  creds: OpenWAGroupCreds,
  groupId: string,
  waIds: string[]
): Promise<ParticipantResult[]> {
  return participantOp(creds, groupId, waIds, '/participants', 'POST');
}

export function removeParticipants(
  creds: OpenWAGroupCreds,
  groupId: string,
  waIds: string[]
): Promise<ParticipantResult[]> {
  return participantOp(creds, groupId, waIds, '/participants', 'DELETE');
}

export function promoteParticipants(
  creds: OpenWAGroupCreds,
  groupId: string,
  waIds: string[]
): Promise<ParticipantResult[]> {
  return participantOp(creds, groupId, waIds, '/participants/promote', 'POST');
}

export function demoteParticipants(
  creds: OpenWAGroupCreds,
  groupId: string,
  waIds: string[]
): Promise<ParticipantResult[]> {
  return participantOp(creds, groupId, waIds, '/participants/demote', 'POST');
}

/**
 * Sort an add's per-person results. 200 (added) and 409 (already in)
 * count as added; 404 (not on WhatsApp) is invalid; everything else is
 * refused, including `success: true` with 403, which means WhatsApp
 * would not add them and the gateway sent a private invite instead.
 * A requested person with no result is refused (not known to be in).
 */
export function classifyAddResults(
  requestedWaIds: string[],
  results: ParticipantResult[]
): { added: WhapiIdentity[]; refused: WhapiIdentity[]; invalid: string[] } {
  const byWaId = new Map<string, ParticipantResult>();
  for (const r of results) {
    const waId = fromOpenWAParticipantId(r.id).waId;
    if (waId) byWaId.set(waId, r);
  }
  const added: WhapiIdentity[] = [];
  const refused: WhapiIdentity[] = [];
  const invalid: string[] = [];
  for (const requested of requestedWaIds) {
    const openwaId = toOpenWAParticipantId(requested);
    if (!openwaId) {
      invalid.push(requested);
      continue;
    }
    const identity = fromOpenWAParticipantId(openwaId);
    const r = identity.waId ? byWaId.get(identity.waId) : undefined;
    if (!r) {
      refused.push(identity);
      continue;
    }
    const who = fromOpenWAParticipantId(r.id);
    const status = r.status ?? (r.success ? 200 : null);
    if (status === 404) invalid.push(requested);
    else if (status === 200 || status === 409) added.push(who);
    else refused.push(who);
  }
  return { added, refused, invalid };
}

// ============================================================
// Invite links
// ============================================================

function inviteOf(raw: unknown): { code: string; link: string } {
  const r = rec(raw);
  const code = str(r.inviteCode) ?? '';
  const link =
    str(r.inviteLink) ?? (code ? `https://chat.whatsapp.com/${code}` : '');
  return { code, link };
}

export async function getInviteCode(
  creds: OpenWAGroupCreds,
  groupId: string
): Promise<{ code: string; link: string }> {
  const raw = await openwaRequest<unknown>({
    ...creds,
    path: groupPath(groupId, '/invite-code'),
    route: 'message',
  });
  return inviteOf(raw);
}

export async function revokeInviteCode(
  creds: OpenWAGroupCreds,
  groupId: string
): Promise<{ code: string; link: string }> {
  const raw = await openwaRequest<unknown>({
    ...creds,
    path: groupPath(groupId, '/invite-code/revoke'),
    method: 'POST',
    route: 'message',
  });
  return inviteOf(raw);
}

/** What an invite code points at, without joining. Untyped upstream. */
export async function getJoinInfo(
  creds: OpenWAGroupCreds,
  code: string
): Promise<WhapiGroupPreview> {
  const raw = rec(
    await openwaRequest<unknown>({
      ...creds,
      path: `/groups/join-info?code=${encodeURIComponent(code)}`,
      route: 'message',
    })
  );
  const size = num(raw.size);
  return {
    id: serializedId(raw.id) ?? serializedId(raw.gid),
    name: str(raw.subject) ?? str(raw.name) ?? '',
    participantsCount:
      size ??
      (Array.isArray(raw.participants) ? raw.participants.length : null),
    createdAt: unixSeconds(raw.creation ?? raw.createdAt),
  };
}

export async function joinGroup(
  creds: OpenWAGroupCreds,
  code: string
): Promise<string> {
  const raw = await openwaRequest<unknown>({
    ...creds,
    path: '/groups/join',
    method: 'POST',
    body: { inviteCode: code },
    route: 'message',
  });
  const r = rec(raw);
  const groupId =
    str(raw) ?? serializedId(r.groupId) ?? serializedId(r.id) ?? null;
  if (!groupId) {
    throw new OpenWAError('OpenWA joined a group but sent no id.', 502, {
      route: 'message',
    });
  }
  return groupId;
}

// ============================================================
// Picture
// ============================================================

export async function getPictureUrl(
  creds: OpenWAGroupCreds,
  groupId: string
): Promise<string | null> {
  const raw = await openwaRequest<unknown>({
    ...creds,
    path: groupPath(groupId, '/picture'),
    route: 'message',
  });
  const r = rec(raw);
  return str(raw) ?? str(r.url) ?? str(r.pictureUrl) ?? str(r.profilePicUrl);
}

/** `base64` may be bare or a `data:<mime>;base64,` URI. */
export async function setPicture(
  creds: OpenWAGroupCreds,
  groupId: string,
  picture: { base64: string; mimetype: string }
): Promise<void> {
  const m = /^data:([^;,]+)?;base64,/.exec(picture.base64);
  const base64 = m ? picture.base64.slice(m[0].length) : picture.base64;
  await openwaRequest<unknown>({
    ...creds,
    path: groupPath(groupId, '/picture'),
    method: 'PUT',
    body: { base64, mimetype: picture.mimetype },
    route: 'message',
  });
}

export async function deletePicture(
  creds: OpenWAGroupCreds,
  groupId: string
): Promise<void> {
  await openwaRequest<unknown>({
    ...creds,
    path: groupPath(groupId, '/picture'),
    method: 'DELETE',
    route: 'message',
  });
}

// ============================================================
// Join requests
// ============================================================

export async function listJoinRequests(
  creds: OpenWAGroupCreds,
  groupId: string
): Promise<WhapiJoinRequest[]> {
  const raw = await openwaRequest<unknown>({
    ...creds,
    path: groupPath(groupId, '/membership-requests'),
    route: 'message',
  });
  const list = Array.isArray(raw) ? raw : [];
  const out: WhapiJoinRequest[] = [];
  for (const item of list) {
    const r = rec(item);
    const id = serializedId(r.participantId);
    if (!id) continue;
    out.push({
      ...fromOpenWAParticipantId(id),
      method: str(r.method),
      requestedAt: unixSeconds(r.requestedAt),
    });
  }
  return out;
}

/**
 * Always exactly one person: an empty or missing `participants` makes
 * the gateway approve or reject EVERY pending request.
 */
async function joinRequestOp(
  creds: OpenWAGroupCreds,
  groupId: string,
  waId: string,
  action: 'approve' | 'reject'
): Promise<void> {
  const [id] = waId ? participantIds([waId]) : [];
  if (!id) {
    throw new OpenWAError('A join request needs exactly one person.', 400, {
      route: 'message',
    });
  }
  await openwaRequest<unknown>({
    ...creds,
    path: groupPath(groupId, `/membership-requests/${action}`),
    method: 'POST',
    body: { participants: [id] },
    route: 'message',
  });
}

export function approveJoinRequest(
  creds: OpenWAGroupCreds,
  groupId: string,
  waId: string
): Promise<void> {
  return joinRequestOp(creds, groupId, waId, 'approve');
}

export function rejectJoinRequest(
  creds: OpenWAGroupCreds,
  groupId: string,
  waId: string
): Promise<void> {
  return joinRequestOp(creds, groupId, waId, 'reject');
}
