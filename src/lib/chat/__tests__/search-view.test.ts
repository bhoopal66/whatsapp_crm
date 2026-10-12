import { describe, expect, it } from 'vitest';

import {
  groupSearchHits,
  highlightSegments,
  matchPeople,
  normalizeDigits,
  queryTerms,
  searchHitHref,
  searchSnippet,
  snippetParts,
} from '../search-view';
import type { SearchHit } from '../types';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SARA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const hit = (o: Partial<SearchHit>): SearchHit => ({
  messageId: 'm',
  channelId: A,
  threadRootId: null,
  authorId: null,
  body: '',
  createdAt: '2026-10-12T10:00:00Z',
  rank: 1,
  ...o,
});

describe('normalizeDigits / queryTerms', () => {
  it('maps Arabic-Indic digits to ASCII, one for one', () => {
    expect(normalizeDigits('٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹')).toBe(
      '0123456789 0123456789'
    );
  });

  it('folds case and digits, drops operators and duplicates', () => {
    expect(queryTerms('  Mashreq "loan" -fee OR mashreq ٥٠٠ ')).toEqual([
      'mashreq',
      'loan',
      'fee',
      '500',
    ]);
  });
});

describe('highlightSegments', () => {
  it('marks every match of every term, case-insensitively', () => {
    expect(
      highlightSegments('Loan for MASHREQ loan', ['loan', 'mashreq'])
    ).toEqual([
      { text: 'Loan', hit: true },
      { text: ' for ', hit: false },
      { text: 'MASHREQ', hit: true },
      { text: ' ', hit: false },
      { text: 'loan', hit: true },
    ]);
  });

  it('matches ASCII terms against Arabic-Indic digits in the text', () => {
    expect(highlightSegments('AED ٥٠٠ only', queryTerms('500'))).toEqual([
      { text: 'AED ', hit: false },
      { text: '٥٠٠', hit: true },
      { text: ' only', hit: false },
    ]);
  });

  it('merges overlapping matches and returns plain text without terms', () => {
    expect(highlightSegments('abcd', ['abc', 'bcd'])).toEqual([
      { text: 'abcd', hit: true },
    ]);
    expect(highlightSegments('abc', [])).toEqual([{ text: 'abc', hit: false }]);
    expect(highlightSegments('', ['a'])).toEqual([]);
  });
});

describe('searchSnippet', () => {
  it('keeps a short body whole', () => {
    expect(searchSnippet('short', ['x'])).toEqual({
      text: 'short',
      before: false,
      after: false,
    });
  });

  it('centres a long body on the first match', () => {
    const body = `${'a'.repeat(300)} needle ${'b'.repeat(300)}`;
    const s = searchSnippet(body, ['needle'], 100);
    expect(s.text).toContain('needle');
    expect(s.text.length).toBe(100);
    expect(s).toMatchObject({ before: true, after: true });
  });

  it('never cuts a mention token in half', () => {
    const body = `${'x'.repeat(30)} <@${SARA}> needle ${'y'.repeat(300)}`;
    const s = searchSnippet(body, ['needle'], 60);
    expect(s.text.startsWith(`<@${SARA}>`)).toBe(true);
    const tail = `${'z'.repeat(50)} <@${SARA}> end`;
    const e = searchSnippet(tail + 'q'.repeat(200), ['zzz'], 60);
    expect(e.text.endsWith(`<@${SARA}>`)).toBe(true);
  });
});

describe('snippetParts', () => {
  it('renders mention chips and highlights the text around them', () => {
    expect(
      snippetParts(
        `ask <@${SARA}> about Mashreq`,
        ['mashreq'],
        [{ userId: SARA, fullName: 'Sara' }]
      )
    ).toEqual([
      { type: 'text', text: 'ask ', hit: false },
      { type: 'mention', userId: SARA, name: 'Sara' },
      { type: 'text', text: ' about ', hit: false },
      { type: 'text', text: 'Mashreq', hit: true },
    ]);
  });
});

describe('groupSearchHits', () => {
  it('groups by channel in order of each best hit, keeping ranked order', () => {
    const hits = [
      hit({ messageId: '1', channelId: A }),
      hit({ messageId: '2', channelId: B }),
      hit({ messageId: '3', channelId: A }),
    ];
    expect(
      groupSearchHits(hits).map((g) => [
        g.channelId,
        g.hits.map((h) => h.messageId),
      ])
    ).toEqual([
      [A, ['1', '3']],
      [B, ['2']],
    ]);
    expect(groupSearchHits([])).toEqual([]);
  });
});

describe('searchHitHref', () => {
  it('opens the channel, and the thread for a reply', () => {
    expect(searchHitHref({ channelId: A, threadRootId: null })).toBe(
      `/chat/${A}`
    );
    expect(searchHitHref({ channelId: A, threadRootId: B })).toBe(
      `/chat/${A}?thread=${B}`
    );
  });
});

describe('matchPeople', () => {
  const people = [
    { userId: '3', fullName: 'Sara Khan' },
    { userId: '1', fullName: 'Omar Saeed' },
    { userId: '2', fullName: null },
    { userId: '4', fullName: 'Ahmed Sarawi' },
  ];

  it('needs every word in the name, sorted by name', () => {
    expect(matchPeople(people, 'sar').map((p) => p.userId)).toEqual(['4', '3']);
    expect(matchPeople(people, 'sara khan').map((p) => p.userId)).toEqual([
      '3',
    ]);
  });

  it('returns nobody for an empty query and honours the limit', () => {
    expect(matchPeople(people, '  ')).toEqual([]);
    expect(matchPeople(people, 'a', 1)).toHaveLength(1);
  });
});
