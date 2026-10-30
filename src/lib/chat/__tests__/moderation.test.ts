import { describe, expect, it } from 'vitest';

import {
  activeRestriction,
  canModerate,
  canRestrictMember,
  isChannelModerator,
  moderationReasonValid,
  reasonLength,
  removedByModerator,
  RESTRICT_DURATION_KEYS,
  restrictionEnd,
  restrictUntil,
} from '../moderation';

describe('restrictionEnd', () => {
  it('reads the Postgres text form and ISO, else null', () => {
    expect(restrictionEnd('2026-10-30 10:00:01+00')?.toISOString()).toBe(
      '2026-10-30T10:00:01.000Z'
    );
    expect(restrictionEnd('2026-10-30T12:00:00+02:00')?.toISOString()).toBe(
      '2026-10-30T10:00:00.000Z'
    );
    expect(restrictionEnd('garbage')).toBeNull();
    expect(restrictionEnd(null)).toBeNull();
  });
});

const ME = '11111111-1111-4111-8111-111111111111';
const YOU = '22222222-2222-4222-8222-222222222222';
const theirs = { authorKind: 'user' as const, authorId: YOU };
const mine = { authorKind: 'user' as const, authorId: ME.toUpperCase() };
const system = { authorKind: 'system' as const, authorId: null };
const plain = { userId: ME, workspaceAdmin: false, channelAdmin: false };

describe('isChannelModerator', () => {
  it('is a channel admin of a team or private channel, never a guest', () => {
    for (const kind of ['team', 'private'] as const)
      expect(
        isChannelModerator({ kind, role: 'admin', bankGuest: false })
      ).toBe(true);
    for (const kind of ['dm', 'deal_room'] as const)
      expect(
        isChannelModerator({ kind, role: 'admin', bankGuest: false })
      ).toBe(false);
    expect(
      isChannelModerator({ kind: 'team', role: 'member', bankGuest: false })
    ).toBe(false);
    expect(
      isChannelModerator({ kind: 'private', role: 'admin', bankGuest: true })
    ).toBe(false);
    expect(
      isChannelModerator({ kind: 'team', role: null, bankGuest: false })
    ).toBe(false);
  });
});

describe('canModerate', () => {
  it('never one’s own post', () => {
    expect(
      canModerate(mine, { ...plain, workspaceAdmin: true, channelAdmin: true })
    ).toBe(false);
  });
  it('someone else’s: a workspace admin or a channel admin', () => {
    expect(canModerate(theirs, plain)).toBe(false);
    expect(canModerate(theirs, { ...plain, workspaceAdmin: true })).toBe(true);
    expect(canModerate(theirs, { ...plain, channelAdmin: true })).toBe(true);
  });
  it('a channel admin of a DM or deal room is not a moderator', () => {
    for (const kind of ['dm', 'deal_room'] as const) {
      const channelAdmin = isChannelModerator({
        kind,
        role: 'admin',
        bankGuest: false,
      });
      expect(canModerate(theirs, { ...plain, channelAdmin })).toBe(false);
    }
  });
  it('system posts: workspace owner/admin only', () => {
    expect(canModerate(system, { ...plain, channelAdmin: true })).toBe(false);
    expect(canModerate(system, { ...plain, workspaceAdmin: true })).toBe(true);
  });
});

describe('moderationReasonValid', () => {
  it('takes 5–500 characters after trimming, counted as code points', () => {
    expect(moderationReasonValid('')).toBe(false);
    expect(moderationReasonValid('abcd')).toBe(false);
    expect(moderationReasonValid('   abcd   ')).toBe(false);
    expect(moderationReasonValid('abcde')).toBe(true);
    expect(moderationReasonValid('x'.repeat(500))).toBe(true);
    expect(moderationReasonValid('x'.repeat(501))).toBe(false);
    expect(moderationReasonValid('😀'.repeat(5))).toBe(true);
    expect(moderationReasonValid('😀'.repeat(500))).toBe(true);
  });
});

describe('moderationReasonValid matches chat_assert_reason', () => {
  it('needs 5 non-whitespace characters, not 5 characters', () => {
    expect(moderationReasonValid('a b c')).toBe(false);
    expect(moderationReasonValid('a b c d e')).toBe(true);
    expect(moderationReasonValid('ab\tcd\nef')).toBe(true);
    expect(moderationReasonValid('ab cd')).toBe(false);
  });
  it('trims only space, tab, CR and LF; NBSP counts as whitespace', () => {
    expect(reasonLength(' \t\r\nabcde \t\r\n')).toBe(5);
    expect(reasonLength('\u00a0abcde')).toBe(6);
    expect(moderationReasonValid('\u00a0\u00a0abc')).toBe(false);
    expect(moderationReasonValid('abcde\u00a0')).toBe(true);
  });
  it('allows 500 after the trim, refuses 501', () => {
    expect(moderationReasonValid(`  ${'x'.repeat(500)}\n`)).toBe(true);
    expect(moderationReasonValid('x'.repeat(501))).toBe(false);
    expect(reasonLength(` ${'x'.repeat(501)} `)).toBe(501);
  });
});

describe('30-day timeout', () => {
  it('ends short of 30 days so clock skew cannot trip the database', () => {
    const now = Date.parse('2026-10-30T10:00:00Z');
    const end = Date.parse(restrictUntil('30d', now));
    expect(30 * 86_400_000 - (end - now)).toBe(5 * 60_000);
  });
});

describe('removedByModerator', () => {
  const base = { deletedAt: 'x', authorId: YOU };
  it('is a deletion by someone other than the author', () => {
    expect(removedByModerator({ ...base, deletedBy: ME })).toBe(true);
    expect(removedByModerator({ ...base, deletedBy: YOU.toUpperCase() })).toBe(
      false
    );
    expect(removedByModerator({ ...base, deletedBy: null })).toBe(false);
    expect(
      removedByModerator({ deletedAt: null, deletedBy: ME, authorId: YOU })
    ).toBe(false);
    expect(
      removedByModerator({ deletedAt: 'x', deletedBy: ME, authorId: null })
    ).toBe(true);
  });
});

describe('timeouts', () => {
  const now = Date.parse('2026-10-30T10:00:00Z');
  it('turns each duration into an ISO time, 30 days at most', () => {
    expect(RESTRICT_DURATION_KEYS).toEqual([
      '1h',
      '8h',
      '1d',
      '3d',
      '7d',
      '30d',
    ]);
    expect(restrictUntil('1h', now)).toBe('2026-10-30T11:00:00.000Z');
    expect(restrictUntil('8h', now)).toBe('2026-10-30T18:00:00.000Z');
    expect(restrictUntil('1d', now)).toBe('2026-10-31T10:00:00.000Z');
    expect(restrictUntil('3d', now)).toBe('2026-11-02T10:00:00.000Z');
    expect(restrictUntil('7d', now)).toBe('2026-11-06T10:00:00.000Z');
    expect(restrictUntil('30d', now)).toBe('2026-11-29T09:55:00.000Z');
  });
  it('a restriction counts only while its time is in the future', () => {
    expect(activeRestriction(null, now)).toBeNull();
    expect(activeRestriction('garbage', now)).toBeNull();
    expect(activeRestriction('2026-10-30T09:59:59Z', now)).toBeNull();
    expect(activeRestriction('2026-10-30T10:00:00Z', now)).toBeNull();
    expect(activeRestriction('2026-10-30 10:00:01+00', now)).toBe(
      '2026-10-30 10:00:01+00'
    );
  });
});

describe('canRestrictMember', () => {
  const base = {
    kind: 'team' as const,
    viewerId: ME,
    viewerWorkspaceAdmin: false,
    viewerChannelAdmin: true,
    memberId: YOU,
    memberRole: 'member' as const,
    memberWorkspaceAdmin: false,
  };
  it('follows chat_restrict_member', () => {
    expect(canRestrictMember(base)).toBe(true);
    expect(canRestrictMember({ ...base, kind: 'private' })).toBe(true);
    expect(canRestrictMember({ ...base, kind: 'dm' })).toBe(false);
    expect(canRestrictMember({ ...base, kind: 'deal_room' })).toBe(false);
    expect(canRestrictMember({ ...base, viewerChannelAdmin: false })).toBe(
      false
    );
    expect(canRestrictMember({ ...base, memberId: ME })).toBe(false);
    expect(canRestrictMember({ ...base, memberWorkspaceAdmin: true })).toBe(
      false
    );
    // A channel admin restricts only non-admins; a workspace admin may.
    expect(canRestrictMember({ ...base, memberRole: 'admin' })).toBe(false);
    expect(
      canRestrictMember({
        ...base,
        memberRole: 'admin',
        viewerWorkspaceAdmin: true,
        viewerChannelAdmin: false,
      })
    ).toBe(true);
  });
});
