import { describe, expect, it } from 'vitest';

import { buildCsv } from '@/lib/csv/build';

import {
  TAG_CSV_HEADER,
  dailySeries,
  groupsTotal,
  isSplitKind,
  parseChatTagReport,
  splitFor,
  splitName,
  splitRows,
  tagCsvRows,
  tagGroups,
  tagLabel,
  DEFAULT_TAG_CSV_LABELS,
} from './tag-report';

const RAW = {
  history_since: '2026-11-22T08:00:00Z',
  tags: [
    {
      id: 'int',
      parent_id: null,
      name: 'Interested',
      color: '#16a34a',
      sub_tag_title: 'Bank',
      position: 1,
    },
    {
      id: 'new',
      parent_id: null,
      name: 'New',
      color: '#2563eb',
      sub_tag_title: null,
      position: 0,
    },
    {
      id: 'adcb',
      parent_id: 'int',
      name: 'ADCB',
      color: null,
      sub_tag_title: null,
      position: 0,
    },
    {
      id: 'enbd',
      parent_id: 'int',
      name: 'ENBD',
      color: null,
      sub_tag_title: null,
      position: 1,
    },
  ],
  current: [
    { tag_id: 'int', sub_tag_id: 'adcb', chats: 5 },
    { tag_id: 'int', sub_tag_id: null, chats: 2 },
    { tag_id: 'int', sub_tag_id: 'enbd', chats: 7 },
    { tag_id: 'new', sub_tag_id: null, chats: '3' },
    { tag_id: 'gone', sub_tag_id: null, chats: 1 },
  ],
  by_agent: [
    { tag_id: 'int', key: null, name: null, chats: 4 },
    { tag_id: 'int', key: 'u1', name: 'Sara', chats: 10 },
    { tag_id: 'new', key: 'u2', name: null, chats: 3 },
  ],
  by_number: [{ tag_id: 'int', key: 'w1', name: 'Sales', chats: 14 }],
  by_source: [
    { tag_id: 'int', key: 'none', chats: 9 },
    { tag_id: 'int', key: 'ad', chats: 5 },
  ],
  arrivals: [{ tag_id: 'int', sub_tag_id: 'adcb', chats: 2 }],
  arrivals_daily: [
    { day: '2026-11-20', tag_id: 'int', chats: 1 },
    { day: '2026-11-22', tag_id: 'int', chats: 1 },
    { day: '2026-11-22', tag_id: 'new', chats: 4 },
    { day: 'bad', tag_id: 'new', chats: 4 },
  ],
};

describe('parseChatTagReport', () => {
  it('reads every section', () => {
    const r = parseChatTagReport(RAW);
    expect(r.historySince).toBe('2026-11-22T08:00:00Z');
    expect(r.tags).toHaveLength(4);
    expect(r.tags[0]).toEqual({
      id: 'int',
      parentId: null,
      name: 'Interested',
      color: '#16a34a',
      subTagTitle: 'Bank',
      position: 1,
    });
    expect(r.current.find((c) => c.tagId === 'new')?.chats).toBe(3);
    expect(r.byAgent[0]).toEqual({
      tagId: 'int',
      key: null,
      name: null,
      chats: 4,
    });
    expect(r.bySource[0].key).toBe('none');
    // A malformed day is dropped.
    expect(r.arrivalsDaily).toHaveLength(3);
  });

  it('tolerates garbage', () => {
    for (const raw of [null, 'x', 42, [], { tags: 'no', current: [null, 1] }]) {
      const r = parseChatTagReport(raw);
      expect(r.tags).toEqual([]);
      expect(r.current).toEqual([]);
      expect(r.historySince).toBeNull();
    }
  });

  it('turns a negative or non-numeric count into 0', () => {
    const r = parseChatTagReport({
      current: [
        { tag_id: 'a', chats: -3 },
        { tag_id: 'b', chats: 'many' },
      ],
    });
    expect(r.current.map((c) => c.chats)).toEqual([0, 0]);
  });
});

describe('tagGroups', () => {
  const r = parseChatTagReport(RAW);
  const groups = tagGroups(r.tags, r.current);

  it('orders main tags by position, unknown ones last', () => {
    expect(groups.map((g) => g.tagId)).toEqual(['new', 'int', 'gone']);
    expect(groups[2].tag).toBeNull();
  });

  it('totals a main tag over its sub-tags, none included', () => {
    const int = groups.find((g) => g.tagId === 'int')!;
    expect(int.total).toBe(14);
    expect(int.rows.map((x) => [x.subTagName, x.chats])).toEqual([
      ['ENBD', 7],
      ['ADCB', 5],
      [null, 2],
    ]);
    expect(groupsTotal(groups)).toBe(18);
  });

  it('labels a row "Main · Sub"', () => {
    expect(tagLabel('Interested', 'ADCB')).toBe('Interested · ADCB');
    expect(tagLabel('New', null)).toBe('New');
  });
});

describe('splits', () => {
  const r = parseChatTagReport(RAW);

  it('knows the split kinds', () => {
    expect(isSplitKind('agent')).toBe(true);
    expect(isSplitKind('bank')).toBe(false);
  });

  it('lists one tag, largest first, none last', () => {
    expect(splitFor(splitRows(r, 'agent'), 'int').map((x) => x.key)).toEqual([
      'u1',
      null,
    ]);
    expect(splitFor(splitRows(r, 'source'), 'int').map((x) => x.key)).toEqual([
      'ad',
      'none',
    ]);
  });

  it('names rows', () => {
    const l = DEFAULT_TAG_CSV_LABELS;
    expect(splitName('agent', r.byAgent[0], l)).toBe('Unassigned');
    expect(splitName('agent', r.byAgent[1], l)).toBe('Sara');
    expect(splitName('agent', r.byAgent[2], l)).toBe('Unknown');
    expect(splitName('number', r.byNumber[0], l)).toBe('Sales');
    expect(splitName('source', r.bySource[0], l)).toBe('Unknown');
    expect(splitName('source', r.bySource[1], l)).toBe('ad');
  });
});

describe('dailySeries', () => {
  it('fills every day between the first and last arrival', () => {
    const s = dailySeries(parseChatTagReport(RAW));
    expect(s.categories).toEqual(['New', 'Interested']);
    expect(s.data).toEqual([
      { day: '2026-11-20', New: 0, Interested: 1 },
      { day: '2026-11-21', New: 0, Interested: 0 },
      { day: '2026-11-22', New: 4, Interested: 1 },
    ]);
  });

  it('keeps two tags with the same name apart', () => {
    const s = dailySeries(
      parseChatTagReport({
        tags: [
          { id: 'a', name: 'X', position: 0 },
          { id: 'b', name: 'X', position: 1 },
        ],
        arrivals_daily: [
          { day: '2026-01-01', tag_id: 'a', chats: 1 },
          { day: '2026-01-01', tag_id: 'b', chats: 2 },
        ],
      })
    );
    expect(s.categories).toEqual(['X', 'X (2)']);
    expect(s.data[0]).toEqual({ day: '2026-01-01', X: 1, 'X (2)': 2 });
  });

  it('is empty with no arrivals', () => {
    expect(dailySeries(parseChatTagReport({}))).toEqual({
      data: [],
      categories: [],
    });
  });
});

describe('tagCsvRows', () => {
  it('writes every section', () => {
    const rows = tagCsvRows(parseChatTagReport(RAW));
    const sections = [...new Set(rows.map((r) => r[0]))];
    expect(sections).toEqual([
      'Chats on the tag now',
      'Now, by agent',
      'Now, by number',
      'Now, by lead source',
      'Arrived in the period',
      'Arrived per day',
    ]);
    expect(rows).toContainEqual([
      'Chats on the tag now',
      'Interested',
      'ADCB',
      '',
      '',
      5,
    ]);
    expect(rows).toContainEqual([
      'Chats on the tag now',
      'Interested',
      'No sub-tag',
      '',
      '',
      2,
    ]);
    expect(rows).toContainEqual([
      'Chats on the tag now',
      'Unknown tag',
      'No sub-tag',
      '',
      '',
      1,
    ]);
    expect(rows).toContainEqual([
      'Now, by agent',
      'Interested',
      '',
      'Sara',
      '',
      10,
    ]);
    expect(rows).toContainEqual([
      'Arrived per day',
      'New',
      '',
      '',
      '2026-11-22',
      4,
    ]);
    for (const r of rows) expect(r).toHaveLength(TAG_CSV_HEADER.length);
  });

  it('goes through buildCsv, which neutralises a formula-looking tag name', () => {
    const csv = buildCsv(
      TAG_CSV_HEADER,
      tagCsvRows(
        parseChatTagReport({
          tags: [{ id: 'a', name: '=HYPERLINK("x")', position: 0 }],
          current: [{ tag_id: 'a', sub_tag_id: null, chats: 1 }],
        })
      )
    );
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
