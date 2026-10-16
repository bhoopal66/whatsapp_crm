// ============================================================
// WhatsApp groups — request parsing and pure guards for the routes
// under /api/whatsapp/groups/[id]/ (participants, invite, requests,
// managers, icon, messages). Every parser throws a 400 GroupHttpError
// (`invalid_body`) before any access check or Whapi call, so a bad body
// never costs a gateway request.
// ============================================================

import {
  planParticipantBatches,
  toParticipantWaId,
  type BatchPlan,
  type GroupFailureKey,
} from '@/lib/whatsapp/groups';

import {
  ICON_MAX_BYTES,
  ICON_TYPES,
  INVITE_MESSAGE_MAX,
} from './limits';
import { GroupHttpError, isUuid } from './server';

// Client components import these from './limits' (this file reaches
// server.ts, which must never enter the browser bundle).
export { ICON_MAX_BYTES, ICON_TYPES, INVITE_MESSAGE_MAX };
import type { WhatsappGroupRow } from './types';

const bad = (message: string) =>
  new GroupHttpError(400, 'invalid_body', message);

/** Most people one request may name (phones + contacts together). */
export const MAX_RECIPIENTS = 200;

function asObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw bad('Body must be a JSON object');
  }
  return raw as Record<string, unknown>;
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw bad(`${field} must be a list of strings`);
  }
  if (value.length > MAX_RECIPIENTS) {
    throw bad(`${field} may name at most ${MAX_RECIPIENTS} entries`);
  }
  return [...new Set((value as string[]).map((v) => v.trim()))].filter(Boolean);
}

function uuidList(value: unknown, field: string): string[] {
  const list = stringList(value, field);
  if (list.some((v) => !isUuid(v))) throw bad(`${field} must be ids`);
  return list;
}

/** People to reach, by phone and/or CRM contact. */
export interface RecipientInput {
  phones: string[];
  contactIds: string[];
}

function recipientInput(b: Record<string, unknown>): RecipientInput {
  const out = {
    phones: stringList(b.phones, 'phones'),
    contactIds: uuidList(b.contactIds, 'contactIds'),
  };
  if (out.phones.length + out.contactIds.length === 0) {
    throw bad('Name at least one phone or contact');
  }
  if (out.phones.length + out.contactIds.length > MAX_RECIPIENTS) {
    throw bad(`At most ${MAX_RECIPIENTS} people per request`);
  }
  return out;
}

/** POST participants: `{ phones?, contactIds? }`. */
export function parseAddMembers(raw: unknown): RecipientInput {
  return recipientInput(asObject(raw));
}

function waIdList(value: unknown): string[] {
  const list = stringList(value, 'waIds');
  if (list.length === 0) throw bad('waIds must name at least one person');
  const waIds: string[] = [];
  for (const input of list) {
    const waId = toParticipantWaId(input);
    if (!waId) throw bad(`Not a WhatsApp number: ${input}`);
    if (!waIds.includes(waId)) waIds.push(waId);
  }
  return waIds;
}

/** DELETE participants: `{ waIds }`, normalised to wa_id digits. */
export function parseMemberList(raw: unknown): { waIds: string[] } {
  return { waIds: waIdList(asObject(raw).waIds) };
}

/** PATCH participants: `{ waIds, role: 'admin' | 'member' }`. */
export function parseRoleChange(raw: unknown): {
  waIds: string[];
  role: 'admin' | 'member';
} {
  const b = asObject(raw);
  if (b.role !== 'admin' && b.role !== 'member') {
    throw bad('role must be admin or member');
  }
  return { waIds: waIdList(b.waIds), role: b.role };
}

/** WhatsApp's limit on a text message. */
export const GROUP_TEXT_MAX = 4096;

export type InviteAction =
  | { action: 'reset' }
  | ({ action: 'send'; message: string | null } & RecipientInput);

/** POST invite: `{ action: 'reset' }` or `{ action: 'send', … }`. */
export function parseInviteAction(raw: unknown): InviteAction {
  const b = asObject(raw);
  if (b.action === 'reset') return { action: 'reset' };
  if (b.action !== 'send') throw bad('action must be reset or send');
  let message: string | null = null;
  if (b.message !== undefined && b.message !== null) {
    if (typeof b.message !== 'string') throw bad('message must be text');
    if (b.message.length > INVITE_MESSAGE_MAX) {
      throw bad(`message must be at most ${INVITE_MESSAGE_MAX} characters`);
    }
    message = b.message.trim() || null;
  }
  return { action: 'send', message, ...recipientInput(b) };
}

/** POST requests: `{ applicant, action: 'approve' | 'reject' }`. */
export function parseJoinDecision(raw: unknown): {
  applicant: string;
  action: 'approve' | 'reject';
} {
  const b = asObject(raw);
  if (b.action !== 'approve' && b.action !== 'reject') {
    throw bad('action must be approve or reject');
  }
  const applicant =
    typeof b.applicant === 'string' ? toParticipantWaId(b.applicant) : null;
  if (!applicant) throw bad('applicant must be a WhatsApp number');
  return { applicant, action: b.action };
}

export const MAX_MANAGERS = 50;

/** PUT managers: `{ userIds }`, the whole new set. */
export function parseManagerSet(raw: unknown): { userIds: string[] } {
  const userIds = uuidList(asObject(raw).userIds, 'userIds');
  if (userIds.length > MAX_MANAGERS) {
    throw bad(`At most ${MAX_MANAGERS} managers`);
  }
  return { userIds };
}


/** An uploaded icon's type and size, checked before Whapi sees it. */
export function checkIconUpload(file: unknown): {
  mimeType: (typeof ICON_TYPES)[number];
} {
  if (
    typeof file !== 'object' ||
    file === null ||
    typeof (file as Blob).arrayBuffer !== 'function'
  ) {
    throw bad('Send the image as the multipart field "file"');
  }
  const blob = file as Blob;
  const type = blob.type.toLowerCase();
  if (!(ICON_TYPES as readonly string[]).includes(type)) {
    throw bad('The icon must be a JPEG or PNG image');
  }
  if (blob.size === 0) throw bad('The image is empty');
  if (blob.size > ICON_MAX_BYTES) {
    throw new GroupHttpError(413, 'too_large', 'The icon must be 2 MB or less');
  }
  return { mimeType: type as (typeof ICON_TYPES)[number] };
}

export const MESSAGES_PAGE_DEFAULT = 50;
export const MESSAGES_PAGE_MAX = 100;

/** GET messages: `?before=<ISO time>&limit=<1-100>`. */
export function parseMessagePage(params: URLSearchParams): {
  before: string | null;
  limit: number;
} {
  const rawBefore = params.get('before');
  let before: string | null = null;
  if (rawBefore) {
    const t = Date.parse(rawBefore);
    if (Number.isNaN(t)) throw bad('before must be a timestamp');
    before = new Date(t).toISOString();
  }
  const rawLimit = params.get('limit');
  let limit = MESSAGES_PAGE_DEFAULT;
  if (rawLimit !== null) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MESSAGES_PAGE_MAX) {
      throw bad(`limit must be 1-${MESSAGES_PAGE_MAX}`);
    }
  }
  return { before, limit };
}

/** POST messages: `{ text }` (text only for now). */
export function parseGroupText(raw: unknown): { text: string } {
  const b = asObject(raw);
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) throw bad('text must not be empty');
  if (text.length > GROUP_TEXT_MAX) {
    throw bad(`text must be at most ${GROUP_TEXT_MAX} characters`);
  }
  return { text };
}

/**
 * Anti-ban ceiling on what staff send into one group: outbound rows of
 * the last minute, failed ones included (a failing number retried in a
 * loop is what WhatsApp reads as spam).
 */
export const GROUP_SEND_LIMIT = { perWindow: 20, windowMs: 60_000 } as const;

/** A cached invite link younger than this is served without Whapi. */
export const INVITE_CACHE_MS = 60 * 60 * 1000;

export function isFreshInvite(fetchedAt: string, now = Date.now()): boolean {
  const t = Date.parse(fetchedAt);
  return !Number.isNaN(t) && now - t >= 0 && now - t < INVITE_CACHE_MS;
}

/**
 * Invite links go out 1:1 from the group's number, so they are paced
 * like adds (`GROUP_ADD_POLICY`: a handful per burst, a pause between
 * bursts, a ceiling per request).
 */
export function planInviteSends(waIds: string[]): BatchPlan {
  return planParticipantBatches(waIds);
}

/**
 * Failures that will repeat for every later recipient (the number, the
 * group or the plan, not the person): stop sending on the first one.
 */
export const INVITE_STOP_ON: readonly GroupFailureKey[] = [
  'not_whapi',
  'not_admin',
  'group_not_found',
  'rate_limited',
  'channel_disconnected',
  'billing',
];

/** Our number's wa_id is among `waIds`. */
export function namesOurNumber(
  waIds: readonly string[],
  ourWaId: string | null
): boolean {
  return !!ourWaId && waIds.includes(ourWaId);
}

/** Our number left the group: nothing can be done on it (409 `left`). */
export function requireActive(group: Pick<WhatsappGroupRow, 'our_role'>) {
  if (group.our_role === 'left') {
    throw new GroupHttpError(409, 'left', 'Your number has left this group');
  }
}

/** A WhatsApp admin-only action (403 `not_group_admin`). */
export function requireGroupAdmin(group: Pick<WhatsappGroupRow, 'our_role'>) {
  requireActive(group);
  if (group.our_role !== 'admin') {
    throw new GroupHttpError(
      403,
      'not_group_admin',
      "Your number isn't an admin of this group"
    );
  }
}
