import { describe, expect, it, vi } from 'vitest';

import {
  ADD_STAFF_MAX,
  addPeopleFailure,
  addRoomPeople,
  parseAddPeopleBody,
} from './people';

const A = '00000000-0000-4000-8000-0000000000aa';
const B = '00000000-0000-4000-8000-0000000000BB';

describe('parseAddPeopleBody', () => {
  it('takes staff ids (deduped, lower-cased) or one guest id', () => {
    expect(parseAddPeopleBody({ staff: [A, B, A] })).toEqual({
      kind: 'staff',
      userIds: [A, B.toLowerCase()],
    });
    expect(parseAddPeopleBody({ guest: A })).toEqual({
      kind: 'guest',
      userId: A,
    });
  });

  it('refuses both, neither, empty, too many or non-ids', () => {
    for (const body of [
      {},
      null,
      { staff: [A], guest: A },
      { staff: [] },
      { staff: ['x'] },
      { guest: 'x' },
      { staff: Array.from({ length: ADD_STAFF_MAX + 1 }, () => A) },
    ]) {
      expect(typeof parseAddPeopleBody(body)).toBe('string');
    }
  });
});

describe('addPeopleFailure', () => {
  const said = (code: string, message: string) =>
    addPeopleFailure({ code, message: `deal rooms: ${message}` });

  it('names each refusal of the two functions', () => {
    expect(
      said('42501', 'only a manager of this room can add people')
    ).toMatchObject({
      status: 403,
      code: 'not_manager',
    });
    expect(
      said('42501', 'only a team leader or an admin can add a bank guest')
    ).toMatchObject({
      status: 403,
      code: 'not_leader',
    });
    expect(said('22023', 'the room is closed')).toMatchObject({
      status: 409,
      code: 'room_closed',
      error: 'The room is closed',
    });
    expect(said('22023', `${A} is not staff of this workspace`).code).toBe(
      'not_staff'
    );
    expect(
      said('22023', 'that person is not a bank guest of this workspace').code
    ).toBe('not_guest');
    expect(
      said('22023', 'this room has no approved ADCB participant')
    ).toMatchObject({
      status: 409,
      code: 'no_bank_participant',
      detail: { bank: 'ADCB' },
    });
    expect(
      said(
        '22023',
        "FAB officers cannot join customer groups (the bank's DSA agreement is not checked)"
      )
    ).toMatchObject({ code: 'bank_guests_off', detail: { bank: 'FAB' } });
  });

  it('rethrows what is not a refusal', () => {
    expect(() =>
      addPeopleFailure({ code: '08006', message: 'down' })
    ).toThrow();
  });
});

describe('addRoomPeople', () => {
  it('calls each function as the caller and counts the new members', async () => {
    const rpc = vi.fn(async () => ({ data: 2, error: null }));
    const db = { rpc } as never;
    expect(
      await addRoomPeople(db, 'room-1', { kind: 'staff', userIds: [A] })
    ).toEqual({
      ok: true,
      added: 2,
    });
    expect(rpc).toHaveBeenCalledWith('deal_room_add_staff', {
      p_room: 'room-1',
      p_user_ids: [A],
    });
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '22023', message: 'deal rooms: the room is closed' },
    } as never);
    expect(
      await addRoomPeople(db, 'room-1', { kind: 'guest', userId: A })
    ).toMatchObject({
      ok: false,
      code: 'room_closed',
    });
    expect(rpc).toHaveBeenLastCalledWith('deal_room_add_guest_user', {
      p_room: 'room-1',
      p_user_id: A,
    });
  });
});
