import { describe, expect, it } from 'vitest';

import {
  mergeVoicePlays,
  ownVoiceNoteIds,
  playedSummary,
  RECEIPTS_MAX_MEMBERS,
} from '../receipts';
import type { VoicePlay } from '../types';

const members = (...ids: string[]) => ids.map((userId) => ({ userId }));
const play = (userId: string, playedAt: string, messageId = 'm1') => ({
  messageId,
  userId,
  playedAt,
});

describe('playedSummary', () => {
  it('a 1:1 DM says nothing before the other person plays it', () => {
    const r = playedSummary({
      plays: [],
      members: members('me', 'you'),
      authorId: 'me',
      kind: 'dm',
    });
    expect(r).toEqual({ label: 'none', played: [], notYet: ['you'] });
  });

  it('a 1:1 DM says Played once the other person has', () => {
    const r = playedSummary({
      plays: [play('you', '2026-10-30T10:00:00Z')],
      members: members('me', 'you'),
      authorId: 'me',
      kind: 'dm',
    });
    expect(r.label).toBe('played');
    expect(r.notYet).toEqual([]);
  });

  it("ignores the author's own play", () => {
    const r = playedSummary({
      plays: [play('ME', '2026-10-30T10:00:00Z')],
      members: members('me', 'you'),
      authorId: 'me',
      kind: 'dm',
    });
    expect(r.label).toBe('none');
    expect(r.played).toEqual([]);
  });

  it('a group names who played (once each, earliest first) and who has not', () => {
    const r = playedSummary({
      plays: [
        play('b', '2026-10-30T10:05:00Z'),
        play('a', '2026-10-30T10:01:00Z'),
        play('B', '2026-10-30T10:02:00Z'),
      ],
      members: members('me', 'a', 'b', 'c'),
      authorId: 'me',
      kind: 'private',
    });
    expect(r.label).toBe('playedBy');
    expect(r.played).toEqual([
      { userId: 'a', playedAt: '2026-10-30T10:01:00Z' },
      { userId: 'B', playedAt: '2026-10-30T10:02:00Z' },
    ]);
    expect(r.notYet).toEqual(['c']);
  });

  it('a group DM (3+) counts like a channel', () => {
    const r = playedSummary({
      plays: [play('a', '2026-10-30T10:00:00Z')],
      members: members('me', 'a', 'b'),
      authorId: 'me',
      kind: 'dm',
    });
    expect(r.label).toBe('playedBy');
  });

  it('still counts a listener who has left', () => {
    const r = playedSummary({
      plays: [play('gone', '2026-10-30T10:00:00Z')],
      members: members('me', 'a'),
      authorId: 'me',
      kind: 'team',
    });
    expect(r.played.map((p) => p.userId)).toEqual(['gone']);
    expect(r.notYet).toEqual(['a']);
  });

  it('shows nothing in a deal room or a channel over the receipts cap', () => {
    const plays = [play('a', '2026-10-30T10:00:00Z')];
    expect(
      playedSummary({
        plays,
        members: members('me', 'a'),
        authorId: 'me',
        kind: 'deal_room',
      }).label
    ).toBe('none');
    const big = members(
      'me',
      ...Array.from({ length: RECEIPTS_MAX_MEMBERS }, (_, i) => `u${i}`)
    );
    expect(
      playedSummary({ plays, members: big, authorId: 'me', kind: 'team' }).label
    ).toBe('none');
  });
});

describe('ownVoiceNoteIds', () => {
  const voice = { kind: 'voice' } as never;
  const file = { kind: 'file' } as never;

  it("keeps the viewer's live voice notes only", () => {
    const ids = ownVoiceNoteIds(
      [
        { id: '1', authorId: 'ME', attachments: [voice] },
        { id: '2', authorId: 'other', attachments: [voice] },
        { id: '3', authorId: 'me', attachments: [file] },
        { id: '4', authorId: 'me', attachments: [voice], deletedAt: 't' },
        { id: '5', authorId: 'me', attachments: [voice], erasedAt: 't' },
        { id: '6', authorId: 'me', attachments: [file, voice] },
      ],
      'me'
    );
    expect(ids).toEqual(['1', '6']);
  });

  it('is empty with no viewer', () => {
    expect(
      ownVoiceNoteIds([{ id: '1', authorId: null, attachments: [voice] }], null)
    ).toEqual([]);
  });
});

describe('mergeVoicePlays', () => {
  const held: Record<string, VoicePlay[]> = {
    m1: [play('a', '2026-10-30T10:00:00Z')],
  };

  it('returns the same object for a play already held', () => {
    expect(mergeVoicePlays(held, [play('A', '2026-10-30T10:00:00Z')])).toBe(
      held
    );
    expect(mergeVoicePlays(held, [play('a', '2026-10-30T11:00:00Z')])).toBe(
      held
    );
    expect(mergeVoicePlays(held, [])).toBe(held);
  });

  it('adds a new person and a new message', () => {
    const out = mergeVoicePlays(held, [
      play('b', '2026-10-30T10:01:00Z'),
      play('a', '2026-10-30T10:02:00Z', 'm2'),
    ]);
    expect(out.m1.map((p) => p.userId)).toEqual(['a', 'b']);
    expect(out.m2.map((p) => p.userId)).toEqual(['a']);
    expect(held.m1).toHaveLength(1);
  });

  it('keeps the earlier of two plays by one person', () => {
    const out = mergeVoicePlays(held, [play('a', '2026-10-30T09:00:00Z')]);
    expect(out.m1).toEqual([play('a', '2026-10-30T09:00:00Z')]);
  });
});
