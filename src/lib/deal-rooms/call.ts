/**
 * Deal rooms — a 1:1 phone call to someone in the room (plan 015 §7.2):
 * the Members panel offers Call per participant, and
 * `POST /api/pbx/calls/dial { participantId }` places it.
 *
 * Participants' numbers never reach a client (088 shows staff a masked
 * phone and nobody a WhatsApp id), so the route resolves the number here,
 * on the service role, confined to the caller's account; the caller's
 * right to the room is asked separately, as the caller.
 *
 * Who can be called: a listed customer, partner or bank officer who was
 * let into the room (invited, joined or since left), never our own
 * number, an unlisted person who came in through the link, someone
 * removed or rejected, or anyone in a room that is closed or failed. A
 * bank officer only while their bank's guests are on (D-Y7).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { normalizeRemoteNumber } from '@/lib/pbx/phone';

const CALLABLE_ROLES = new Set(['customer', 'partner', 'bank_guest']);
const CALLABLE_STATUSES = new Set(['invited', 'joined', 'left']);
const ENDED_ROOMS = new Set(['closed', 'failed']);

export type ParticipantCallBlock =
  'not_callable' | 'room_closed' | 'bank_guests_off';

export function participantCallBlock(input: {
  role: string | null;
  status: string;
  roomStatus: string;
  /** The bank's `guests_allowed`; read only for a bank officer. */
  bankGuestsAllowed: boolean;
}): ParticipantCallBlock | null {
  if (
    !input.role ||
    !CALLABLE_ROLES.has(input.role) ||
    !CALLABLE_STATUSES.has(input.status)
  ) {
    return 'not_callable';
  }
  if (ENDED_ROOMS.has(input.roomStatus)) return 'room_closed';
  if (input.role === 'bank_guest' && !input.bankGuestsAllowed) {
    return 'bank_guests_off';
  }
  return null;
}

/**
 * Whether the Members panel draws Call on a person's row: business-side
 * staff (agent and up, the dial route's floor; never a bank guest) for a
 * callable person. Whether the bank's guests are on, the caller's own
 * extension and do-not-contact are the route's to answer.
 */
export function offersParticipantCall(
  viewerRole: AccountRole | null,
  p: { role: string | null; status: string },
  roomStatus: string
): boolean {
  if (!viewerRole || !hasMinRole(viewerRole, 'agent')) return false;
  const block = participantCallBlock({
    role: p.role,
    status: p.status,
    roomStatus,
    bankGuestsAllowed: true,
  });
  return block === null;
}

export type ParticipantCallee =
  | {
      ok: true;
      roomId: string;
      number: string;
      contactId: string | null;
    }
  | { ok: false; status: number; code: string; error: string };

interface ParticipantRow {
  id: string;
  room_id: string;
  role: string | null;
  status: string;
  bank_code: string | null;
  phone: string | null;
  wa_id: string | null;
  contact_id: string | null;
}

const NOT_FOUND = {
  ok: false,
  status: 404,
  code: 'not_found',
  error: 'Participant not found',
} as const;

/**
 * The person and number to call, read on the service role inside
 * `accountId` only: another workspace's participant is "not found".
 */
export async function participantCallee(
  service: SupabaseClient,
  accountId: string,
  participantId: string
): Promise<ParticipantCallee> {
  const { data, error } = await service
    .from('deal_room_participants')
    .select('id, room_id, role, status, bank_code, phone, wa_id, contact_id')
    .eq('id', participantId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(`participant read failed: ${error.message}`);
  const p = data as ParticipantRow | null;
  if (!p) return NOT_FOUND;

  const { data: room, error: roomErr } = await service
    .from('deal_rooms')
    .select('id, status')
    .eq('id', p.room_id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (roomErr) throw new Error(`room read failed: ${roomErr.message}`);
  if (!room) return NOT_FOUND;

  let bankGuestsAllowed = false;
  if (p.role === 'bank_guest' && p.bank_code) {
    const { data: bank, error: bankErr } = await service
      .from('bank_guest_policies')
      .select('guests_allowed')
      .eq('account_id', accountId)
      .eq('bank_code', p.bank_code)
      .maybeSingle();
    if (bankErr) throw new Error(`bank policy read failed: ${bankErr.message}`);
    bankGuestsAllowed =
      (bank as { guests_allowed?: boolean } | null)?.guests_allowed === true;
  }

  const block = participantCallBlock({
    role: p.role,
    status: p.status,
    roomStatus: (room as { status: string }).status,
    bankGuestsAllowed,
  });
  if (block === 'bank_guests_off') {
    return {
      ok: false,
      status: 409,
      code: block,
      error: "This bank's officers can't be called: its guests are off",
    };
  }
  if (block === 'room_closed') {
    return {
      ok: false,
      status: 409,
      code: block,
      error: 'This deal room is closed',
    };
  }
  if (block) {
    return {
      ok: false,
      status: 409,
      code: block,
      error: "This person can't be called from the room",
    };
  }

  const n = normalizeRemoteNumber(p.phone ?? p.wa_id);
  if (!n || n.internal) {
    return {
      ok: false,
      status: 422,
      code: 'no_number',
      error: 'This person has no phone number to call',
    };
  }
  return {
    ok: true,
    roomId: p.room_id,
    number: n.number,
    contactId: p.contact_id,
  };
}
