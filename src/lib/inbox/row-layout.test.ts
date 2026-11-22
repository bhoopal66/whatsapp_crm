import { describe, expect, it } from 'vitest';
import {
  compactSubTagLabel,
  rowAssignee,
  rowHasDetailLine,
  rowOffersAssign,
} from './row-layout';

describe('compactSubTagLabel', () => {
  it('keeps a short name whole', () => {
    expect(compactSubTagLabel('ADCB')).toBe('ADCB');
    expect(compactSubTagLabel('RAKBANK')).toBe('RAKBANK');
    expect(compactSubTagLabel('  Emirates  ')).toBe('Emirates');
  });

  it('takes initials of a long multi-word name', () => {
    expect(compactSubTagLabel('Abu Dhabi Commercial Bank')).toBe('ADCB');
    expect(compactSubTagLabel('first abu dhabi bank')).toBe('FADB');
  });

  it('takes the first word of a two-word name when it fits', () => {
    expect(compactSubTagLabel('Emirates NBD')).toBe('Emirates');
    expect(compactSubTagLabel('Mashreq Bank')).toBe('Mashreq');
  });

  it('cuts anything else with an ellipsis, within the limit', () => {
    const out = compactSubTagLabel('Commercialbank International');
    expect(out).toBe('Commerc…');
    expect(Array.from(out).length).toBeLessThanOrEqual(8);
    expect(compactSubTagLabel('Supercalifragilistic')).toBe('Superca…');
  });

  it('honours a custom limit', () => {
    expect(compactSubTagLabel('RAKBANK', 4)).toBe('RAK…');
  });
});

describe('rowAssignee', () => {
  it('names an assignee', () => {
    expect(rowAssignee({ userId: 'u1', kind: 'assigned' }, 'Omar')).toEqual({
      kind: 'assigned',
      name: 'Omar',
    });
  });

  it('reads Unassigned for an owner-only chat, keeping the owner', () => {
    expect(rowAssignee({ userId: 'u1', kind: 'owner' }, 'Omar')).toEqual({
      kind: 'unassigned',
      ownerName: 'Omar',
    });
  });

  it('reads Unassigned with nobody behind it', () => {
    expect(rowAssignee(null, null)).toEqual({
      kind: 'unassigned',
      ownerName: null,
    });
  });
});

describe('rowOffersAssign', () => {
  const base = {
    showAssignee: true,
    assignedAgentId: null,
    personalOwnerId: null,
    hrRow: false,
    assignableCount: 3,
    shareOnly: false,
  };

  it('offers Assign on an unassigned company chat', () => {
    expect(rowOffersAssign(base)).toBe(true);
  });

  it.each([
    ['assignee column hidden', { showAssignee: false }],
    ['already assigned', { assignedAgentId: 'u1' }],
    ['personal chat', { personalOwnerId: 'u2' }],
    ['HR row', { hrRow: true }],
    ['nobody to offer', { assignableCount: 0 }],
    ['share-only viewer', { shareOnly: true }],
  ])('not when %s', (_label, over) => {
    expect(rowOffersAssign({ ...base, ...over })).toBe(false);
  });
});

describe('rowHasDetailLine', () => {
  it('appears for the meta line or a chat tag', () => {
    expect(rowHasDetailLine({ hasMeta: false, hasChatTag: false })).toBe(false);
    expect(rowHasDetailLine({ hasMeta: true, hasChatTag: false })).toBe(true);
    expect(rowHasDetailLine({ hasMeta: false, hasChatTag: true })).toBe(true);
  });
});
