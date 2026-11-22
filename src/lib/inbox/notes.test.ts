import { describe, expect, it } from 'vitest';

import {
  activeMentionToken,
  canSaveNote,
  filterMentionCandidates,
  insertMention,
  isBlankNote,
  mentionedIds,
  mergeNote,
  NOTE_MAX_LENGTH,
  splitNoteMentions,
} from './notes';

const sara = { user_id: 'u-sara', full_name: 'Sara Khan' };
const sam = { user_id: 'u-sam', full_name: 'Sam' };
const samir = { user_id: 'u-samir', full_name: 'Samir Ali' };
const blank = { user_id: 'u-blank', full_name: '  ' };

describe('note limits', () => {
  it('treats whitespace of any kind as blank (241 uses [[:space:]])', () => {
    expect(isBlankNote('')).toBe(true);
    expect(isBlankNote(' \t\n')).toBe(true);
    expect(isBlankNote(' x ')).toBe(false);
  });

  it('saves only non-blank notes within the limit', () => {
    expect(canSaveNote('called him')).toBe(true);
    expect(canSaveNote('   ')).toBe(false);
    expect(canSaveNote('a'.repeat(NOTE_MAX_LENGTH))).toBe(true);
    expect(canSaveNote('a'.repeat(NOTE_MAX_LENGTH + 1))).toBe(false);
  });
});

describe('activeMentionToken', () => {
  it('finds the token at the caret, spaces allowed', () => {
    expect(activeMentionToken('hi @Sar', 7)).toEqual({
      query: 'Sar',
      start: 3,
      end: 7,
    });
    expect(activeMentionToken('@Sara K', 7)?.query).toBe('Sara K');
    expect(activeMentionToken('@', 1)).toEqual({ query: '', start: 0, end: 1 });
  });

  it('ignores email addresses, line breaks and a stray at sign', () => {
    expect(activeMentionToken('mail a@b.com', 12)).toBeNull();
    expect(activeMentionToken('@Sara\nnext', 10)).toBeNull();
    expect(activeMentionToken('price @ 5', 9)).toBeNull();
    expect(activeMentionToken('no token', 8)).toBeNull();
  });

  it('reads only up to the caret', () => {
    expect(activeMentionToken('@Sa and more', 3)?.query).toBe('Sa');
  });
});

describe('filterMentionCandidates', () => {
  const all = [samir, sara, sam, blank];

  it('puts name starts before word starts and drops blank names', () => {
    expect(filterMentionCandidates(all, 'sa').map((c) => c.user_id)).toEqual([
      'u-samir',
      'u-sara',
      'u-sam',
    ]);
    expect(filterMentionCandidates(all, 'khan')).toEqual([sara]);
    expect(filterMentionCandidates(all, '')).toHaveLength(3);
    expect(filterMentionCandidates(all, 'zz')).toEqual([]);
  });

  it('caps the list', () => {
    expect(filterMentionCandidates(all, '', 2)).toHaveLength(2);
  });
});

describe('insertMention', () => {
  it('replaces the typed token with the full name and a space', () => {
    const token = activeMentionToken('ask @sa please', 7)!;
    expect(insertMention('ask @sa please', token, 'Sara Khan')).toEqual({
      text: 'ask @Sara Khan please',
      caret: 15,
    });
  });
});

describe('mentionedIds', () => {
  it('keeps only people still named, once each', () => {
    const body = '@Sara Khan and @Sam, then @Sara Khan again';
    expect(mentionedIds(body, [sara, sam, samir, sara])).toEqual([
      'u-sara',
      'u-sam',
    ]);
  });

  it('does not read @Samir as @Sam, nor an email as a mention', () => {
    expect(mentionedIds('@Samir Ali', [sam, samir])).toEqual(['u-samir']);
    expect(mentionedIds('x@Sam', [sam])).toEqual([]);
  });
});

describe('splitNoteMentions', () => {
  it('marks the rung names, longest first', () => {
    expect(
      splitNoteMentions('@Sara Khan call @Sara', ['Sara', 'Sara Khan'])
    ).toEqual([
      { text: '@Sara Khan', mention: true },
      { text: ' call ', mention: false },
      { text: '@Sara', mention: true },
    ]);
  });

  it('leaves text alone without names or mid-word', () => {
    expect(splitNoteMentions('a@Sam', ['Sam'])).toEqual([
      { text: 'a@Sam', mention: false },
    ]);
    expect(splitNoteMentions('plain', [])).toEqual([
      { text: 'plain', mention: false },
    ]);
  });
});

describe('mergeNote', () => {
  const note = (id: string, at: string, body = 'x') => ({
    id,
    account_id: 'a',
    conversation_id: 'c',
    author_id: 'u',
    body,
    mention_ids: [],
    created_at: at,
    edited_at: null,
  });

  it('inserts in time order and replaces an edited row', () => {
    const a = note('a', '2026-11-22T08:00:00Z');
    const b = note('b', '2026-11-22T09:00:00Z');
    expect(mergeNote([b], a).map((n) => n.id)).toEqual(['a', 'b']);
    const edited = mergeNote([a, b], { ...a, body: 'new' });
    expect(edited.map((n) => n.body)).toEqual(['new', 'x']);
  });
});
