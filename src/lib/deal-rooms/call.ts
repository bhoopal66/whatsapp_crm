/**
 * Deal rooms — a 1:1 phone call to someone in the room (plan 015 §7.2):
 * the Members panel offers Call per participant, and
 * `POST /api/pbx/calls/dial { participantId }` places it.
 *
 * The request carries only the participant's id: the route reads the
 * number itself, on the service role, confined to the caller's account,
 * so no number from the browser is dialled this way. The number is not
 * hidden from room staff (088's staff policy lets them read
 * `deal_room_participants.phone` and `wa_id`; the Members panel only
 * shows it masked). The caller's right to the room is asked first, as
 * the caller, and nothing about the person is judged before it
 * (`participantRoomId`, then `participantCallee`), so someone without
 * that right learns nothing of their role or status.
 *
 * Who can be called: a listed customer, partner or bank officer who was
 * let into the room (invited, joined or since left), never our own
 * number, an unlisted person who came in through the link, someone
 * removed or rejected, or anyone in a room that is closed or failed. A
 * bank officer only while their bank's guests are on (D-Y7).
 *
 * A call with a bank officer is a bank call (C-2: unrecorded unless the
 * bank's DSA terms allow it). Before it is dialled, the officer's number
 * is listed in `pbx_bank_numbers` (089) under their bank, so while the
 * workspace excludes bank numbers the event processor marks the
 * recording held (never fetched) and `pbx_recording_playable` never
 * plays it. While the workspace does not exclude them the call would be
 * kept and played, so it is refused unless the bank allows recording
 * (`bank_guest_policies.recording_allowed`, 088, off by default).
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

export type BankCallBlock = 'bank_calls_recorded';

/**
 * Whether a bank officer may be dialled, as far as recording goes (C-2):
 * the CRM keeps the call unrecorded (the workspace excludes bank
 * numbers), or the bank's DSA terms allow recording.
 */
export function bankCallBlock(input: {
  /** The bank's `recording_allowed`. */
  recordingAllowed: boolean;
  /** The workspace's `pbx_settings.exclude_bank_numbers`. */
  excludeBankNumbers: boolean;
}): BankCallBlock | null {
  return input.recordingAllowed || input.excludeBankNumbers
    ? null
    : 'bank_calls_recorded';
}

export type ParticipantCallee =
  | {
      ok: true;
      roomId: string;
      number: string;
      contactId: string | null;
      /** A bank officer's bank: list the number under it before dialling. */
      bankCode: string | null;
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

interface BankPolicy {
  guests_allowed?: boolean;
  recording_allowed?: boolean;
}

const NOT_FOUND = {
  ok: false,
  status: 404,
  code: 'not_found',
  error: 'Participant not found',
} as const;

/**
 * The participant's room, and nothing else about them, read on the
 * service role inside `accountId` only: another workspace's participant
 * is not found (null).
 */
export async function participantRoomId(
  service: SupabaseClient,
  accountId: string,
  participantId: string
): Promise<string | null> {
  const { data, error } = await service
    .from('deal_room_participants')
    .select('room_id')
    .eq('id', participantId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(`participant read failed: ${error.message}`);
  return (data as { room_id: string } | null)?.room_id ?? null;
}

/** `pbx_settings.exclude_bank_numbers`; no row is 089's default, on. */
async function excludesBankNumbers(
  service: SupabaseClient,
  accountId: string
): Promise<boolean> {
  const { data, error } = await service
    .from('pbx_settings')
    .select('exclude_bank_numbers')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(`pbx_settings read failed: ${error.message}`);
  return (
    (data as { exclude_bank_numbers?: boolean } | null)?.exclude_bank_numbers ??
    true
  );
}

/**
 * The person and number to call, once the caller may post in `roomId`:
 * read on the service role inside `accountId` only, and in that room.
 */
export async function participantCallee(
  service: SupabaseClient,
  accountId: string,
  participantId: string,
  roomId: string
): Promise<ParticipantCallee> {
  const { data, error } = await service
    .from('deal_room_participants')
    .select('id, room_id, role, status, bank_code, phone, wa_id, contact_id')
    .eq('id', participantId)
    .eq('account_id', accountId)
    .eq('room_id', roomId)
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

  let bank: BankPolicy | null = null;
  if (p.role === 'bank_guest' && p.bank_code) {
    const { data: policy, error: bankErr } = await service
      .from('bank_guest_policies')
      .select('guests_allowed, recording_allowed')
      .eq('account_id', accountId)
      .eq('bank_code', p.bank_code)
      .maybeSingle();
    if (bankErr) throw new Error(`bank policy read failed: ${bankErr.message}`);
    bank = policy as BankPolicy | null;
  }

  const block = participantCallBlock({
    role: p.role,
    status: p.status,
    roomStatus: (room as { status: string }).status,
    bankGuestsAllowed: bank?.guests_allowed === true,
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

  // Past the block, a bank officer has a bank code (088's CHECK).
  const bankCode = p.role === 'bank_guest' ? p.bank_code : null;
  if (bankCode) {
    const recording = bankCallBlock({
      recordingAllowed: bank?.recording_allowed === true,
      excludeBankNumbers: await excludesBankNumbers(service, accountId),
    });
    if (recording) {
      return {
        ok: false,
        status: 409,
        code: recording,
        error:
          "This bank's calls may not be recorded: turn on \"Don't record calls with bank numbers\" in the phone system's recording rules first",
      };
    }
  }
  return {
    ok: true,
    roomId: p.room_id,
    number: n.number,
    contactId: p.contact_id,
    bankCode,
  };
}

/**
 * Lists a bank officer's number in `pbx_bank_numbers` under their bank,
 * on the service role inside `accountId`, before the call is dialled,
 * so the processor and `pbx_recording_playable` treat it as a bank
 * call. A number already listed keeps its row (an admin's bank code is
 * not rewritten). An error throws, and the call is not placed.
 */
export async function listBankNumber(
  service: SupabaseClient,
  accountId: string,
  number: string,
  bankCode: string
): Promise<void> {
  const { error } = await service.from('pbx_bank_numbers').upsert(
    // 089 caps a listed bank code at 32 characters; it is only a label.
    { account_id: accountId, number, bank_code: bankCode.slice(0, 32) },
    { onConflict: 'account_id,number', ignoreDuplicates: true }
  );
  if (error) throw new Error(`pbx_bank_numbers write failed: ${error.message}`);
}
