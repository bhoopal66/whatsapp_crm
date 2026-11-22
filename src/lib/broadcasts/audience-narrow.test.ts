import { describe, expect, it } from 'vitest';
import {
  bankSubTagIds,
  chatMatchesTags,
  contactIdsForTags,
  hasNarrowing,
  intersectIdSets,
  normalizeNarrowing,
} from './audience-narrow';

const chat = (c: string, main: string | null, sub: string | null) => ({
  contact_id: c,
  chat_tag_id: main,
  chat_sub_tag_id: sub,
});

describe('chatMatchesTags', () => {
  it('any: main or sub is enough', () => {
    expect(chatMatchesTags(chat('c', 'M', 'S'), ['S', 'X'], 'any')).toBe(true);
    expect(chatMatchesTags(chat('c', 'M', null), ['S', 'X'], 'any')).toBe(
      false
    );
  });
  it('all: needs every selected tag, e.g. main plus its sub-tag', () => {
    expect(chatMatchesTags(chat('c', 'M', 'S'), ['M', 'S'], 'all')).toBe(true);
    expect(chatMatchesTags(chat('c', 'M', null), ['M', 'S'], 'all')).toBe(
      false
    );
  });
  it('all: two different main tags can never match', () => {
    expect(chatMatchesTags(chat('c', 'M1', null), ['M1', 'M2'], 'all')).toBe(
      false
    );
  });
  it('empty selection matches nothing in either mode', () => {
    expect(chatMatchesTags(chat('c', 'M', 'S'), [], 'any')).toBe(false);
    expect(chatMatchesTags(chat('c', 'M', 'S'), [], 'all')).toBe(false);
  });
  it('duplicate ids do not change the answer', () => {
    expect(chatMatchesTags(chat('c', 'M', null), ['M', 'M'], 'all')).toBe(true);
  });
});

describe('contactIdsForTags', () => {
  const chats = [
    chat('a', 'M', 'S'),
    chat('b', 'M', null),
    chat('c', null, null),
    { contact_id: null, chat_tag_id: 'M', chat_sub_tag_id: 'S' },
  ];
  it('any returns every contact on a selected tag', () => {
    expect(contactIdsForTags(chats, ['M'], 'any').sort()).toEqual(['a', 'b']);
  });
  it('all narrows to the main+sub holders', () => {
    expect(contactIdsForTags(chats, ['M', 'S'], 'all')).toEqual(['a']);
  });
});

describe('bankSubTagIds', () => {
  const tags = [
    { id: 'm', parent_id: null, name: 'ADCB' },
    { id: 's1', parent_id: 'm', name: 'ADCB' },
    { id: 's2', parent_id: 'm', name: ' fab ' },
    { id: 's3', parent_id: 'm', name: 'Mashreq' },
  ];
  it('matches sub-tags by bank name or code, ignoring case and spaces', () => {
    expect(
      bankSubTagIds(tags, [
        { code: 'ADCB', name: 'Abu Dhabi Commercial' },
        { code: 'FAB', name: 'First Abu Dhabi' },
      ]).sort()
    ).toEqual(['s1', 's2']);
  });
  it('never returns a main tag, and nothing for no banks', () => {
    expect(bankSubTagIds(tags, [{ code: 'adcb' }])).toEqual(['s1']);
    expect(bankSubTagIds(tags, [])).toEqual([]);
  });
});

describe('intersectIdSets', () => {
  it('skips unset filters and intersects the rest', () => {
    expect(intersectIdSets([null, undefined])).toBeNull();
    expect([...intersectIdSets([new Set(['a', 'b']), null])!]).toEqual([
      'a',
      'b',
    ]);
    expect([
      ...intersectIdSets([new Set(['a', 'b']), new Set(['b', 'c'])])!,
    ]).toEqual(['b']);
  });
  it('an empty filter result empties the audience', () => {
    expect(intersectIdSets([new Set(['a']), new Set()])!.size).toBe(0);
  });
});

describe('normalizeNarrowing', () => {
  it('defaults keep today behaviour', () => {
    expect(normalizeNarrowing({})).toEqual({
      chatTagMatch: 'any',
      bankCodes: [],
      bankSource: 'case',
      leadSources: [],
    });
  });
  it('drops unknown lead sources and junk', () => {
    const n = normalizeNarrowing({
      chatTagMatch: 'all',
      bankCodes: ['ADCB', 'ADCB', '', 3],
      bankSource: 'chat_tag',
      leadSources: ['ad', 'nope', 'ad'],
    });
    expect(n).toEqual({
      chatTagMatch: 'all',
      bankCodes: ['ADCB'],
      bankSource: 'chat_tag',
      leadSources: ['ad'],
    });
    expect(hasNarrowing(n)).toBe(true);
    expect(hasNarrowing(normalizeNarrowing({}))).toBe(false);
  });
});
