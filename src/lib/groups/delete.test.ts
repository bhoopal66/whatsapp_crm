import { describe, expect, it } from 'vitest';

import {
  canDeleteGroup,
  canLeaveGroup,
  deleteCopyKeys,
  MAX_JOINED_DELETES,
  parseDeleteOutcome,
  planGroupDelete,
} from './delete';

const row = (n: number, our_role: string, channel_id: string | null = 'c') => ({
  id: `g${n}`,
  channel_id,
  wa_group_id: `${n}@g.us`,
  our_role,
});

describe('planGroupDelete', () => {
  it('puts each group in its own lane, submission groups first', () => {
    const plan = planGroupDelete(
      [row(1, 'left'), row(2, 'admin'), row(3, 'member', null), row(4, 'left')],
      new Set(['4@g.us'])
    );
    expect(plan.left.map((g) => g.id)).toEqual(['g1']);
    expect(plan.joined.map((g) => g.id)).toEqual(['g2']);
    expect(plan.orphaned.map((g) => g.id)).toEqual(['g3']);
    expect(plan.refused.map((g) => g.id)).toEqual(['g4']);
  });

  it('caps the joined lane but never the left one', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      row(i, i % 2 ? 'member' : 'left')
    );
    const plan = planGroupDelete(rows, new Set());
    expect(plan.joined).toHaveLength(MAX_JOINED_DELETES);
    expect(plan.overLimit).toHaveLength(15 - MAX_JOINED_DELETES);
    expect(plan.left).toHaveLength(15);
  });
});

describe('canLeaveGroup', () => {
  it('offers Leave only unblocked and never on a submission group', () => {
    expect(canLeaveGroup(null, false)).toBe(true);
    expect(canLeaveGroup(null, true)).toBe(false);
    expect(canLeaveGroup({ reason: 'not_allowed' }, false)).toBe(false);
  });
});

describe('canDeleteGroup', () => {
  it('shows for owners and admins on any group but a submission group', () => {
    expect(canDeleteGroup('owner', false)).toBe(true);
    expect(canDeleteGroup('admin', false)).toBe(true);
    expect(canDeleteGroup('admin', true)).toBe(false);
    expect(canDeleteGroup('team_leader', false)).toBe(false);
    expect(canDeleteGroup(null, false)).toBe(false);
  });
});

describe('deleteCopyKeys', () => {
  it('keeps the left wording and warns while we are in the group', () => {
    expect(deleteCopyKeys('left').body).toBe('deleteBody');
    expect(deleteCopyKeys('member').body).toBe('deleteJoinedBody');
    expect(deleteCopyKeys('admin').title).toBe('deleteJoinedTitle');
  });
});

describe('parseDeleteOutcome', () => {
  it('reads the four keys and drops malformed entries', () => {
    expect(
      parseDeleteOutcome({
        deleted: ['a', 1],
        skipped: ['b'],
        refused: ['c'],
        failed: [{ id: 'd', reason: 'r' }, { id: 'e' }, null],
      })
    ).toEqual({
      deleted: ['a'],
      skipped: ['b'],
      refused: ['c'],
      failed: [{ id: 'd', reason: 'r' }],
    });
  });

  it('survives a body that is not the answer', () => {
    expect(parseDeleteOutcome(null).deleted).toEqual([]);
    expect(parseDeleteOutcome({ error: 'x' }).failed).toEqual([]);
  });
});
