import { describe, expect, it, vi } from 'vitest';

import {
  addStaffNumber,
  planStaffNumber,
  removeStaffNumber,
  type StaffNumberDeps,
} from './staff-number';
import type { SubmissionGroup } from './store';

const STAFF = '971501112222';
const CUSTOMER = '971503334444';

const group = (over: Partial<SubmissionGroup> = {}) =>
  ({
    id: 'g1',
    accountId: 'a1',
    contactId: 'k1',
    status: 'ACTIVE',
    waMode: 'group',
    channelId: 'ch1',
    waGroupId: 'wa1@g.us',
    ...over,
  }) as SubmissionGroup;

const deps = (over: Partial<StaffNumberDeps> = {}): StaffNumberDeps => ({
  savedPhone: vi.fn().mockResolvedValue(STAFF),
  removalPhone: vi.fn().mockResolvedValue(STAFF),
  customerPhone: vi.fn().mockResolvedValue(CUSTOMER),
  getParticipants: vi.fn().mockResolvedValue([CUSTOMER]),
  addParticipant: vi.fn().mockResolvedValue('added'),
  removeParticipant: vi.fn().mockResolvedValue(undefined),
  ...over,
});

describe('planStaffNumber', () => {
  it('goes only for a live WhatsApp group and a saved number', () => {
    expect(planStaffNumber(group(), `+${STAFF}`, CUSTOMER)).toEqual({
      go: true,
      channelId: 'ch1',
      waGroupId: 'wa1@g.us',
      phone: STAFF,
    });
  });

  it.each([
    [null, {}, 'none', 'no_saved_number'],
    [null, { waMode: 'none' }, 'skipped', 'no_whatsapp'],
    [STAFF, { status: 'ENDED' }, 'skipped', 'not_active'],
    [STAFF, { waMode: 'none' }, 'skipped', 'no_whatsapp'],
    [STAFF, { channelId: null }, 'skipped', 'detached'],
    [STAFF, { waGroupId: null }, 'skipped', 'no_group_yet'],
    [CUSTOMER, {}, 'skipped', 'customer_number'],
  ] as const)('%s %o → %s (%s)', (saved, over, status, reason) => {
    expect(
      planStaffNumber(group(over as Partial<SubmissionGroup>), saved, CUSTOMER)
    ).toEqual({ go: false, status, reason });
  });
});

describe('addStaffNumber', () => {
  it('adds a saved number not yet in the group', async () => {
    const d = deps();
    expect(await addStaffNumber(d, group(), 'u1')).toEqual({ status: 'added' });
    expect(d.savedPhone).toHaveBeenCalledWith('a1', 'u1');
    expect(d.addParticipant).toHaveBeenCalledWith('ch1', 'wa1@g.us', STAFF);
  });

  it('does not add a number already in the group', async () => {
    const d = deps({
      getParticipants: vi.fn().mockResolvedValue([`${STAFF}@s.whatsapp.net`]),
    });
    expect(await addStaffNumber(d, group(), 'u1')).toEqual({
      status: 'already',
    });
    expect(d.addParticipant).not.toHaveBeenCalled();
  });

  it('reports a WhatsApp refusal and a gateway failure without throwing', async () => {
    expect(
      await addStaffNumber(
        deps({ addParticipant: vi.fn().mockResolvedValue('refused') }),
        group(),
        'u1'
      )
    ).toEqual({ status: 'refused', reason: 'privacy' });
    expect(
      await addStaffNumber(
        deps({ addParticipant: vi.fn().mockRejectedValue(new Error('x')) }),
        group(),
        'u1'
      )
    ).toEqual({ status: 'failed', reason: 'gateway' });
  });

  it('calls no gateway without a saved number', async () => {
    // An addition never falls back to the removal number.
    const d = deps({ savedPhone: vi.fn().mockResolvedValue(null) });
    expect((await addStaffNumber(d, group(), 'u1')).status).toBe('none');
    expect(d.getParticipants).not.toHaveBeenCalled();
  });
});

describe('removeStaffNumber', () => {
  it('removes the saved number when it is in the group', async () => {
    const d = deps({
      getParticipants: vi.fn().mockResolvedValue([CUSTOMER, STAFF]),
    });
    expect(await removeStaffNumber(d, group(), 'u1')).toEqual({
      status: 'removed',
    });
    expect(d.removeParticipant).toHaveBeenCalledWith('ch1', 'wa1@g.us', STAFF);
  });

  it('removes the number of someone who is no longer live staff (299)', async () => {
    const d = deps({
      savedPhone: vi.fn().mockResolvedValue(null),
      getParticipants: vi.fn().mockResolvedValue([CUSTOMER, STAFF]),
    });
    expect(await removeStaffNumber(d, group(), 'u1')).toEqual({
      status: 'removed',
    });
    expect(d.removalPhone).toHaveBeenCalledWith('a1', 'u1');
    expect(d.removeParticipant).toHaveBeenCalledWith('ch1', 'wa1@g.us', STAFF);
  });

  it('says so when there is no number to remove', async () => {
    const d = deps({ removalPhone: vi.fn().mockResolvedValue(null) });
    expect(await removeStaffNumber(d, group(), 'u1')).toEqual({
      status: 'none',
      reason: 'no_saved_number',
    });
    expect(d.getParticipants).not.toHaveBeenCalled();
  });

  it('removes nothing when the number is not in the group or the group has no WhatsApp side', async () => {
    const d = deps();
    expect(await removeStaffNumber(d, group(), 'u1')).toEqual({
      status: 'none',
      reason: 'not_in_group',
    });
    expect(
      (await removeStaffNumber(d, group({ waMode: 'none' }), 'u1')).status
    ).toBe('skipped');
    expect(d.removeParticipant).not.toHaveBeenCalled();
  });
});
