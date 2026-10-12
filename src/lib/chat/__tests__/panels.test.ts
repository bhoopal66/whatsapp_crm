import { describe, expect, it } from 'vitest';

import { addRules } from '../membership';
import {
  addPickerRows,
  jumpQuery,
  rightColumn,
  timelineFocusId,
  withRightColumn,
} from '../panels';
import type { ChannelMember, ChatPerson } from '../types';

const R = '11111111-1111-4111-8111-111111111111';
const M = '22222222-2222-4222-8222-222222222222';
const T = '33333333-3333-4333-8333-333333333333';
const q = (s: string) => new URLSearchParams(s);

describe('right column', () => {
  it('reads a thread, else a known panel, else nothing', () => {
    expect(rightColumn(q(`thread=${R}`))).toEqual({
      kind: 'thread',
      rootId: R,
    });
    expect(rightColumn(q('panel=members'))).toEqual({ kind: 'members' });
    expect(rightColumn(q('panel=pins'))).toEqual({ kind: 'pins' });
    expect(rightColumn(q('panel=files'))).toBeNull();
    expect(rightColumn(q('thread=nope'))).toBeNull();
    expect(rightColumn(q(''))).toBeNull();
  });

  it('a thread wins over a panel', () => {
    expect(rightColumn(q(`panel=pins&thread=${R}`))).toEqual({
      kind: 'thread',
      rootId: R,
    });
  });

  it('opening one closes the other and keeps ?message=', () => {
    expect(withRightColumn(`thread=${R}&message=${M}`, { kind: 'pins' })).toBe(
      `?message=${M}&panel=pins`
    );
    expect(
      withRightColumn('panel=members', { kind: 'thread', rootId: R })
    ).toBe(`?thread=${R}`);
    expect(withRightColumn('panel=members', null)).toBe('');
  });
});

describe('jumps', () => {
  it('a reply opens its thread in place of the panel', () => {
    expect(jumpQuery('panel=pins', { id: M, threadRootId: R }, true)).toBe(
      `?thread=${R}&message=${M}`
    );
  });

  it('a top-level message keeps the panel only when asked, and drops a thread', () => {
    expect(jumpQuery('panel=pins', { id: M, threadRootId: null }, true)).toBe(
      `?panel=pins&message=${M}`
    );
    expect(jumpQuery('panel=pins', { id: M, threadRootId: null }, false)).toBe(
      `?message=${M}`
    );
    expect(jumpQuery(`thread=${T}`, { id: M, threadRootId: null }, true)).toBe(
      `?message=${M}`
    );
  });

  it('the timeline focuses the open thread root, else the message', () => {
    expect(timelineFocusId(q(`message=${M}`))).toBe(M);
    expect(timelineFocusId(q(`thread=${R}&message=${M}`))).toBe(R);
    expect(timelineFocusId(q(`thread=${R}`))).toBeNull();
    expect(timelineFocusId(q('message=nope'))).toBeNull();
  });
});

describe('addPickerRows', () => {
  const person = (userId: string, role: string): ChatPerson => ({
    userId,
    fullName: userId,
    avatarUrl: null,
    role,
    bankCode: null,
    presenceStatus: null,
    lastSeenAt: null,
  });
  const member = (userId: string): ChannelMember => ({
    channelId: 'c1',
    userId,
    role: 'member',
    joinedAt: '2026-10-01T00:00:00Z',
    lastReadAt: null,
    muted: false,
  });
  const people = [
    person('gus', 'bank_guest'),
    person('me', 'admin'),
    person('ann', 'agent'),
    person('bob', 'agent'),
  ];
  const rows = (
    kind: 'team' | 'private',
    myRole: 'admin' | 'member',
    accountRole: string
  ) =>
    addPickerRows(
      people,
      [member('ME'), member('bob')],
      addRules({ kind, archived: false, myRole, accountRole }),
      kind
    ).map((r) => [r.person.userId, r.block]);

  it('team: staff pickable, a bank guest listed last with the reason', () => {
    expect(rows('team', 'member', 'agent')).toEqual([
      ['ann', null],
      ['gus', 'guestTeam'],
    ]);
  });

  it('private: a workspace admin who is not a channel admin adds guests only', () => {
    expect(rows('private', 'member', 'admin')).toEqual([
      ['gus', null],
      ['ann', 'staffRole'],
    ]);
  });

  it('private: a channel admin agent adds staff; guests need a leading role', () => {
    expect(rows('private', 'admin', 'agent')).toEqual([
      ['ann', null],
      ['gus', 'guestRole'],
    ]);
  });

  it('nobody to list when the viewer may add no one', () => {
    expect(rows('private', 'member', 'agent')).toEqual([]);
  });
});
