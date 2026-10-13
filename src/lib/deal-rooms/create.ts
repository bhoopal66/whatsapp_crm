/**
 * Deal rooms — creating one (module 014c, migration 088).
 *
 * Two steps on two clients. `deal_room_create` runs as the CALLER: every
 * rule (role, contact visibility, consent, 1–7 invitees, opt-out and
 * do-not-contact, the bank-guest policy, an agent's guests waiting for a
 * team leader) lives there, so its refusals are passed through in its
 * own words. Then the service role asks Meta for the group. Creation is
 * asynchronous: the room stays `creating` until the `group_create`
 * webhook (or the reconcile) opens it, and a Meta refusal marks it
 * `failed` at once, so nothing half-created ever shows as open.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import { createGroup } from '@/lib/whatsapp/meta-groups';

import { dbMessage, metaChannel, notifyRoomAlert } from './shared';

export interface CreateDealRoomInput {
  contactId: string;
  dealId: string | null;
  whatsappConfigId: string | null;
  subject: string;
  description: string | null;
  participants: Record<string, unknown>[];
  consent: { text_version: unknown; consent_text: unknown; method: unknown };
}

export type CreateDealRoomResult =
  | { ok: true; roomId: string; channelId: string; status: 'creating' }
  | { ok: false; status: number; error: string; roomId?: string };

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * The request body → the function's arguments (camelCase → the
 * snake_case keys `deal_room_create` reads). Shape only: the values are
 * the function's to judge.
 */
export function parseCreateBody(
  body: unknown
): { ok: true; value: CreateDealRoomInput } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Expected a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const contactId = text(b.contactId);
  const subject = text(b.subject);
  if (!contactId) return { ok: false, error: 'contactId is required' };
  if (!subject) return { ok: false, error: 'subject is required' };
  if (!Array.isArray(b.participants) || b.participants.length === 0) {
    return { ok: false, error: 'participants must be a non-empty array' };
  }
  const participants: Record<string, unknown>[] = [];
  for (const p of b.participants) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      return { ok: false, error: 'each participant must be an object' };
    }
    const q = p as Record<string, unknown>;
    participants.push({
      display_name: q.displayName ?? null,
      phone: q.phone ?? null,
      role: q.role ?? null,
      contact_id: text(q.contactId),
      bank_code: text(q.bankCode),
    });
  }
  const c = b.consent;
  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    return { ok: false, error: "the customer's consent is required" };
  }
  const consent = c as Record<string, unknown>;
  return {
    ok: true,
    value: {
      contactId,
      dealId: text(b.dealId),
      whatsappConfigId: text(b.whatsappConfigId),
      subject,
      description: text(b.description),
      participants,
      consent: {
        text_version: consent.textVersion ?? null,
        consent_text: consent.consentText ?? null,
        method: consent.method ?? null,
      },
    },
  };
}

/** HTTP status for a `deal_room_create` refusal; 500 for anything else. */
export function createErrorStatus(code: string | undefined): number {
  switch (code) {
    case '42501': // not allowed: role, a contact or deal the caller cannot see
      return 403;
    case '23505': // unique: raced another write
    case '40001':
      return 409;
    case '22023': // the rules: consent, invitees, opt-out, bank policy…
    case '23514':
    case '23502':
    case '22P02': // not a uuid
    case 'P0002': // a number or contact that does not exist
      return 400;
    default:
      return 500;
  }
}

export async function createDealRoom(args: {
  /** The caller's client: `deal_room_create` checks the caller. */
  userDb: SupabaseClient;
  /** The service role: credentials and the server-only functions. */
  adminDb: SupabaseClient;
  accountId: string;
  input: CreateDealRoomInput;
}): Promise<CreateDealRoomResult> {
  const { userDb, adminDb, accountId, input } = args;

  let channel: WhatsAppChannel | null = null;
  let configId = input.whatsappConfigId;
  if (!configId) {
    channel = await metaChannel(adminDb, accountId);
    if (!channel) {
      return {
        ok: false,
        status: 409,
        error:
          'Connect the Meta Cloud API number first: deal rooms are WhatsApp groups, which only the Cloud API can create.',
      };
    }
    configId = channel.id;
  }

  const { data: created, error } = await userDb.rpc('deal_room_create', {
    p_contact_id: input.contactId,
    p_deal_id: input.dealId,
    p_whatsapp_config_id: configId,
    p_subject: input.subject,
    p_description: input.description,
    p_participants: input.participants,
    p_consent: input.consent,
  });
  if (error) {
    const status = createErrorStatus(error.code);
    if (status === 500) {
      console.error('[deal-rooms] deal_room_create failed:', error.message);
      return { ok: false, status, error: 'Could not create the deal room' };
    }
    return { ok: false, status, error: dbMessage(error.message) };
  }
  const roomId = String(created);

  // The stored (trimmed) subject: the reconcile matches the group on it.
  const { data: room, error: roomErr } = await adminDb
    .from('deal_rooms')
    .select('channel_id, created_by, subject, description')
    .eq('id', roomId)
    .single();
  if (roomErr || !room) {
    console.error('[deal-rooms] new room not readable:', roomErr?.message);
    return { ok: false, status: 500, error: 'Could not create the deal room' };
  }

  // Meta refused (or the number cannot be used): the room fails, and its
  // creator and the owners and admins are told, as when the webhook or
  // the reconcile fails it. Unless a manager cancelled it meanwhile
  // (096): then nothing changed, and nobody is told.
  const fail = async (reason: string): Promise<CreateDealRoomResult> => {
    const { data: failed, error: statusErr } = await adminDb.rpc(
      'deal_room_fail_creation',
      { p_room: roomId, p_reason: reason }
    );
    if (statusErr) {
      console.error('[deal-rooms] could not mark failed:', statusErr.message);
    } else if (failed === true) {
      await notifyRoomAlert(
        adminDb,
        {
          id: roomId,
          account_id: accountId,
          channel_id: room.channel_id as string,
          created_by: (room.created_by as string | null) ?? null,
          subject: room.subject as string,
        },
        'Deal room could not be created',
        { event: 'create_failed', reason }
      );
    }
    return {
      ok: false,
      status: 502,
      error: `WhatsApp could not create the group: ${reason}`,
      roomId,
    };
  };

  try {
    channel ??= await metaChannel(adminDb, accountId, configId);
  } catch (err) {
    console.error('[deal-rooms] Meta number not loadable:', err);
    channel = null;
  }
  if (!channel) return fail("the Meta number's credentials could not be read");

  let requestId: string | null;
  try {
    ({ requestId } = await createGroup({
      phoneNumberId: channel.phoneNumberId,
      accessToken: channel.accessToken,
      subject: room.subject as string,
      description: (room.description as string | null) ?? null,
      joinApprovalMode: 'approval_required',
    }));
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Meta API error');
  }

  // Without a request id the webhook cannot be matched; the reconcile
  // finds the group by subject instead.
  if (requestId) {
    const { error: markErr } = await adminDb.rpc('deal_room_mark_requested', {
      p_room: roomId,
      p_request_id: requestId,
    });
    if (markErr) {
      console.error('[deal-rooms] mark_requested failed:', markErr.message);
    }
  }
  return {
    ok: true,
    roomId,
    channelId: room.channel_id as string,
    status: 'creating',
  };
}
