import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';

import {
  MINE_FILTERS,
  countMine,
  dayHeading,
  duplicateLine,
  matchesFilter,
  mineAction,
  mineEmpty,
  mineSummary,
  searchMine,
  statusKey,
  timeText,
  uploadAgainHref,
  uploadPrefill,
} from './my-uploads';
import type { ItemState, MyItem } from './store';

const NS = (en as Record<string, unknown>).DeskFriendly as Record<
  string,
  unknown
>;

function exists(key: string): boolean {
  const v = key
    .split('.')
    .reduce<unknown>(
      (o, k) =>
        o && typeof o === 'object'
          ? (o as Record<string, unknown>)[k]
          : undefined,
      NS
    );
  return typeof v === 'string';
}

const BASE: MyItem = {
  itemId: 'i',
  receivedAt: '2026-11-28T09:00:00Z',
  state: 'filed',
  caseId: null,
  caseNumber: null,
  originalName: null,
  fileId: null,
  queueBankCode: null,
  queueReason: null,
  rejectReason: null,
  duplicateOfItem: null,
  duplicateOfUploader: null,
  kind: null,
  bankCode: null,
  caseRef: null,
  companyName: null,
  tradeLicence: null,
  product: null,
  contactId: null,
  docKey: null,
  note: null,
};

const item = (over: Partial<MyItem>): MyItem => ({ ...BASE, ...over });
const ALL_STATES: ItemState[] = ['untagged', 'rejected', 'filed', 'duplicate'];

describe('countMine', () => {
  it('counts queued and rejected uploads as needing attention', () => {
    const items = [
      item({ state: 'untagged' }),
      item({ state: 'untagged' }),
      item({ state: 'rejected' }),
      item({ state: 'filed' }),
      item({ state: 'duplicate' }),
    ];
    expect(countMine(items)).toEqual({
      all: 5,
      attention: 3,
      untagged: 2,
      rejected: 1,
      filed: 1,
      duplicate: 1,
    });
  });

  it('agrees with the filter for every chip', () => {
    const items = ALL_STATES.map((state) => item({ state }));
    const counts = countMine(items);
    for (const f of MINE_FILTERS)
      expect(counts[f]).toBe(items.filter((i) => matchesFilter(i, f)).length);
  });

  it('is all zeros for no uploads', () => {
    expect(Object.values(countMine([]))).toEqual(MINE_FILTERS.map(() => 0));
  });
});

describe('searchMine', () => {
  const items = [
    item({ itemId: 'a', caseNumber: 'TC-26-04271-RAK', companyName: 'Acme' }),
    item({ itemId: 'b', caseRef: '4271RAKD', originalName: 'Licence.PDF' }),
    item({ itemId: 'c', docKey: 'trade_licence' }),
    item({ itemId: 'd', companyName: 'Blue Sea Trading' }),
  ];
  const ids = (q: string, label?: (k: string) => string) =>
    searchMine(items, q, label).map((i) => i.itemId);

  it('keeps everything for an empty or blank query', () => {
    expect(ids('')).toEqual(['a', 'b', 'c', 'd']);
    expect(ids('   ')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ignores case and surrounding spaces', () => {
    expect(ids('  tc-26-04271  ')).toEqual(['a']);
    expect(ids('ACME')).toEqual(['a']);
    expect(ids('blue SEA')).toEqual(['d']);
    expect(ids('licence.pdf')).toEqual(['b']);
  });

  it('matches the number typed, the file name and the document type', () => {
    expect(ids('4271rakd')).toEqual(['b']);
    expect(ids('licence')).toEqual(['b', 'c']);
    expect(
      ids('Trade Licence', (k) => (k === 'trade_licence' ? 'Trade licence' : k))
    ).toEqual(['c']);
    expect(ids('nothing like it')).toEqual([]);
  });
});

describe('mineSummary', () => {
  const now = new Date('2026-11-28T10:00:00Z'); // 14:00 in Dubai
  it('counts today in the desk zone and attention over every upload', () => {
    const s = mineSummary(
      [
        item({ receivedAt: '2026-11-28T09:00:00Z', state: 'filed' }),
        item({ receivedAt: '2026-11-27T21:00:00Z', state: 'untagged' }), // 01:00 today in Dubai
        item({ receivedAt: '2026-11-20T10:00:00Z', state: 'rejected' }),
        item({ receivedAt: 'not a date', state: 'duplicate' }),
      ],
      now
    );
    expect(s).toEqual({
      key: 'mine.summary',
      values: { count: 2, attention: 2 },
    });
    expect(exists(s.key)).toBe(true);
  });

  it('has a calm variant when nothing needs attention', () => {
    const s = mineSummary([item({ state: 'filed' })], now);
    expect(s).toEqual({ key: 'mine.summaryClear', values: { count: 1 } });
    expect(exists(s.key)).toBe(true);
  });
});

describe('dayHeading and timeText', () => {
  it('says today, yesterday, or the weekday and date', () => {
    expect(dayHeading({ day: '2026-11-28', when: 'today' }, 'en')).toEqual({
      key: 'mine.day.today',
    });
    expect(dayHeading({ day: '2026-11-27', when: 'yesterday' }, 'en')).toEqual({
      key: 'mine.day.yesterday',
    });
    const earlier = dayHeading({ day: '2026-11-24', when: 'earlier' }, 'en');
    expect(earlier.key).toBe('mine.day.earlier');
    expect(String(earlier.values?.date)).toMatch(/Tuesday/);
    expect(String(earlier.values?.date)).toMatch(/24/);
    expect(dayHeading({ day: '', when: 'earlier' }, 'en').key).toBe(
      'mine.day.unknown'
    );
    for (const k of [
      'mine.day.today',
      'mine.day.yesterday',
      'mine.day.earlier',
      'mine.day.unknown',
    ])
      expect(exists(k)).toBe(true);
  });

  it('gives a 24-hour HH:MM in the desk zone', () => {
    expect(timeText('2026-11-28T09:05:00Z', 'en')).toBe('13:05');
    expect(timeText('2026-11-27T21:00:00Z', 'en')).toBe('01:00');
    expect(timeText('nope', 'en')).toBe('');
  });
});

describe('one row', () => {
  it('has a status word for every state', () => {
    for (const s of ALL_STATES) expect(exists(statusKey(s))).toBe(true);
  });

  it('offers one next step: fix a queued upload, resend a rejected one', () => {
    expect(mineAction({ state: 'untagged' })).toBe('fix');
    expect(mineAction({ state: 'rejected' })).toBe('uploadAgain');
    expect(mineAction({ state: 'filed' })).toBeNull();
    expect(mineAction({ state: 'duplicate' })).toBeNull();
  });

  it('says who sent a duplicate first only as far as the row knows', () => {
    const dup = (by: string | null) =>
      duplicateLine({ state: 'duplicate', duplicateOfUploader: by }, 'me');
    expect(dup(null)).toEqual({ key: 'mine.duplicate.plain' });
    expect(dup('me')).toEqual({ key: 'mine.duplicate.you' });
    expect(dup('someone')).toEqual({ key: 'mine.duplicate.colleague' });
    expect(
      duplicateLine({ state: 'filed', duplicateOfUploader: 'me' }, 'me')
    ).toBeNull();
    for (const k of ['plain', 'you', 'colleague'])
      expect(exists(`mine.duplicate.${k}`)).toBe(true);
  });

  it('has a label for every filter chip', () => {
    for (const f of MINE_FILTERS) expect(exists(`mine.filter.${f}`)).toBe(true);
  });
});

describe('mineEmpty', () => {
  const base = { total: 3, shown: 0, filter: 'all' as const, query: '' };
  it('picks the empty state', () => {
    expect(mineEmpty({ ...base, total: 0 })).toBe('none');
    expect(mineEmpty({ ...base, shown: 2 })).toBeNull();
    expect(mineEmpty({ ...base, filter: 'attention' })).toBe('allFiled');
    expect(mineEmpty({ ...base, filter: 'attention', query: 'x' })).toBe(
      'noMatch'
    );
    expect(mineEmpty({ ...base, query: 'x' })).toBe('noMatch');
    expect(mineEmpty({ ...base, filter: 'rejected' })).toBe('noMatch');
  });

  it('only names keys the catalogue has', () => {
    for (const e of ['none', 'noMatch', 'allFiled']) {
      expect(exists(`mine.empty.${e}`)).toBe(true);
      expect(exists(`mine.empty.${e}Help`)).toBe(true);
    }
  });
});

describe('upload again', () => {
  it('links to the Upload tab with the kind and case', () => {
    expect(
      uploadAgainHref({
        kind: 'pending_doc',
        caseNumber: 'TC-26-04271-RAK',
        caseRef: '4271RAKD',
      })
    ).toBe('/desk?kind=pending_doc&case=TC-26-04271-RAK');
    expect(
      uploadAgainHref({ kind: 'info', caseNumber: null, caseRef: '4271RAKD' })
    ).toBe('/desk?kind=info&case=4271RAKD');
    expect(
      uploadAgainHref({ kind: 'new_case', caseNumber: null, caseRef: 'x' })
    ).toBe('/desk?kind=new_case');
    expect(
      uploadAgainHref({ kind: null, caseNumber: null, caseRef: null })
    ).toBe('/desk');
  });

  it('reads back what the link carries, and nothing else', () => {
    const read = (href: string) =>
      uploadPrefill(new URL(href, 'https://x.test').searchParams);
    expect(read('/desk?kind=pending_doc&case=TC-26-04271-RAK')).toEqual({
      kind: 'pending_doc',
      caseRef: 'TC-26-04271-RAK',
    });
    expect(read('/desk?kind=new_case&case=x')).toEqual({
      kind: 'new_case',
      caseRef: '',
    });
    expect(read('/desk?kind=bogus&case=%20R1%20')).toEqual({
      kind: '',
      caseRef: 'R1',
    });
    expect(read(`/desk?case=${'x'.repeat(65)}`)).toBeNull();
    expect(read('/desk')).toBeNull();
    expect(read('/desk?tab=mine')).toBeNull();
  });

  it('round-trips', () => {
    const row = item({ kind: 'pending_doc', caseNumber: 'TC-26-00001-ENB' });
    expect(
      uploadPrefill(
        new URL(uploadAgainHref(row), 'https://x.test').searchParams
      )
    ).toEqual({ kind: 'pending_doc', caseRef: 'TC-26-00001-ENB' });
  });
});
