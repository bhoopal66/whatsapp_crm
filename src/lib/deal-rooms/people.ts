/**
 * Deal rooms — adding people to a room's channel (module 014c,
 * migrations 088 and 096): staff of the workspace through
 * `deal_room_add_staff`, a bank guest login through
 * `deal_room_add_guest_user`. Both run as the caller, so the database
 * decides who may: a manager of the room for staff; a team leader or
 * admin who manages it for a guest, whose bank has an approved officer
 * in the room and is still allowed to join groups. Neither touches the
 * WhatsApp group: these people read the room and its Team notes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { fail, type Fail } from './operations';
import { dbMessage } from './shared';

/** At most this many staff in one request. */
export const ADD_STAFF_MAX = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AddPeopleInput =
  { kind: 'staff'; userIds: string[] } | { kind: 'guest'; userId: string };

/** `{ staff: [ids] }` or `{ guest: id }`, exactly one; else the reason. */
export function parseAddPeopleBody(body: unknown): AddPeopleInput | string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<
    string,
    unknown
  >;
  const hasStaff = b.staff !== undefined;
  const hasGuest = b.guest !== undefined;
  if (hasStaff === hasGuest) return 'Send either staff or guest';
  if (hasGuest) {
    return typeof b.guest === 'string' && UUID.test(b.guest)
      ? { kind: 'guest', userId: b.guest.toLowerCase() }
      : 'guest must be a user id';
  }
  if (!Array.isArray(b.staff) || b.staff.length === 0) {
    return 'staff must list at least one user id';
  }
  if (b.staff.length > ADD_STAFF_MAX) {
    return `At most ${ADD_STAFF_MAX} people at a time`;
  }
  if (!b.staff.every((u) => typeof u === 'string' && UUID.test(u))) {
    return 'staff must list user ids';
  }
  const ids = (b.staff as string[]).map((u) => u.toLowerCase());
  return { kind: 'staff', userIds: [...new Set(ids)] };
}

/** The codes the panel words itself; `bank` rides along where it matters. */
export const ADD_PEOPLE_ERRORS = [
  'not_manager',
  'not_leader',
  'room_closed',
  'not_staff',
  'not_guest',
  'no_bank_participant',
  'bank_guests_off',
] as const;
export type AddPeopleError = (typeof ADD_PEOPLE_ERRORS)[number];

/**
 * A refusal of the two functions as a response, by their wording (each
 * raises one fixed message per rule). Anything else is rethrown.
 */
export function addPeopleFailure(err: {
  code?: string;
  message: string;
}): Fail {
  const m = err.message;
  const bank =
    /no approved (\S+) participant/.exec(m)?.[1] ??
    /deal rooms: (\S+) officers cannot join/.exec(m)?.[1];
  const said = dbMessage(m);
  if (err.code === '42501') {
    if (m.includes('only a manager of this room')) {
      return fail(403, 'not_manager', said);
    }
    if (m.includes('only a team leader or an admin')) {
      return fail(403, 'not_leader', said);
    }
    return fail(403, 'forbidden', said);
  }
  if (err.code === '22023') {
    if (m.includes('the room is closed')) return fail(409, 'room_closed', said);
    if (m.includes('is not staff of this workspace')) {
      return fail(422, 'not_staff', said);
    }
    if (m.includes('not a bank guest of this workspace')) {
      return fail(422, 'not_guest', said);
    }
    if (m.includes('no approved') && bank) {
      return fail(409, 'no_bank_participant', said, { bank });
    }
    if (m.includes('officers cannot join') && bank) {
      return fail(409, 'bank_guests_off', said, { bank });
    }
    return fail(400, 'invalid', said);
  }
  throw new Error(`adding people failed: ${m}`);
}

/** Add them as the caller: `{ added }` counts the new channel members. */
export async function addRoomPeople(
  db: SupabaseClient,
  roomId: string,
  input: AddPeopleInput
): Promise<{ ok: true; added: number } | Fail> {
  if (input.kind === 'staff') {
    const { data, error } = await db.rpc('deal_room_add_staff', {
      p_room: roomId,
      p_user_ids: input.userIds,
    });
    if (error) return addPeopleFailure(error);
    return { ok: true, added: Number(data ?? 0) };
  }
  // The function says nothing of an existing member: count it as added.
  const { error } = await db.rpc('deal_room_add_guest_user', {
    p_room: roomId,
    p_user_id: input.userId,
  });
  if (error) return addPeopleFailure(error);
  return { ok: true, added: 1 };
}
