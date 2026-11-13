import { describe, expect, it } from 'vitest';
import {
  filterExtensions,
  freeExtensions,
  mappingSummary,
  mergeSynced,
  nameScore,
  normalizeName,
  peopleRows,
  personOptions,
  planLink,
  suggestMappings,
  withPbxFields,
  personKey,
  suggestionStillValid,
} from './extension-mapping';
import type { MappableWorkspace } from './admin-ui';

const A = 'acct-a';
const B = 'acct-b';

function ext(
  id: string,
  extension: string,
  o: Partial<{
    accountId: string;
    userId: string | null;
    personName: string | null;
    callerIdName: string | null;
    mapped: boolean;
  }> = {}
) {
  const userId = o.userId ?? null;
  return {
    id,
    extension,
    accountId: o.accountId ?? A,
    userId,
    personName: o.personName ?? null,
    callerIdName: o.callerIdName ?? null,
    mapped: o.mapped ?? userId !== null,
  };
}

const ws: MappableWorkspace[] = [
  {
    accountId: A,
    name: 'Main',
    people: [
      { userId: 'u-fatima', name: 'Fatima Al Zahra' },
      { userId: 'u-omar', name: 'Omar Khalid' },
      { userId: 'u-omar2', name: 'Omar Saeed' },
      { userId: 'u-ravi', name: 'Ravi Kumar' },
      { userId: 'u-noname', name: null },
    ],
  },
  { accountId: B, name: 'Bank', people: [{ userId: 'u-sara', name: 'Sara' }] },
];

describe('normalizeName', () => {
  it('drops case, accents and punctuation, keeps other scripts', () => {
    expect(normalizeName('  José-Luis  O’Neil ')).toBe('jose luis o neil');
    expect(normalizeName('فاطمة  الزهراء')).toBe('فاطمة الزهراء');
    expect(normalizeName(null)).toBe('');
  });
});

describe('nameScore', () => {
  it('ranks the same name, first+last, and a lone first name', () => {
    expect(nameScore('fatima al-zahra', 'Fatima Al Zahra')).toBe(3);
    expect(nameScore('Fatima Zahra', 'Fatima Al Zahra')).toBe(2);
    expect(nameScore('Ravi', 'Ravi Kumar')).toBe(1);
    expect(nameScore('Al', 'Al Zahra')).toBe(0); // too short to trust
    expect(nameScore('Kumar', 'Ravi Kumar')).toBe(0);
    expect(nameScore('', 'Ravi Kumar')).toBe(0);
    expect(nameScore('Ravi', null)).toBe(0);
  });
});

describe('suggestMappings', () => {
  it('suggests the single best fit for unlinked extensions only', () => {
    const rows = [
      ext('e1', '101', { callerIdName: 'Fatima Al Zahra' }),
      ext('e2', '102', { callerIdName: 'Ravi' }),
      ext('e3', '103', { callerIdName: 'Omar' }), // two Omars: ambiguous
      ext('e4', '104', { callerIdName: 'Nobody Here' }),
      ext('e5', '105', {
        callerIdName: 'Omar Khalid',
        userId: 'u-noname',
        personName: null,
      }), // already linked: never re-suggested
    ];
    expect(suggestMappings(rows, ws)).toEqual([
      { extensionId: 'e1', userId: 'u-fatima', name: 'Fatima Al Zahra' },
      { extensionId: 'e2', userId: 'u-ravi', name: 'Ravi Kumar' },
    ]);
  });

  it('never suggests someone who already holds an extension there', () => {
    const rows = [
      ext('e1', '101', { userId: 'u-ravi', personName: 'Ravi Kumar' }),
      ext('e2', '102', { callerIdName: 'Ravi Kumar' }),
    ];
    expect(suggestMappings(rows, ws)).toEqual([]);
  });

  it('a namesake who holds an extension blocks a first-name match', () => {
    const people: MappableWorkspace[] = [
      {
        accountId: A,
        name: 'Main',
        people: [
          { userId: 'u-ali', name: 'Ahmed Ali' },
          { userId: 'u-khan', name: 'Ahmed Khan' },
        ],
      },
    ];
    const rows = [
      ext('e1', '101', { userId: 'u-ali', personName: 'Ahmed Ali' }),
      ext('e5', '105', { callerIdName: 'Ahmed' }),
    ];
    expect(suggestMappings(rows, people)).toEqual([]);
    // The holder's full name on a second line is no suggestion either.
    const full = [
      ext('e1', '101', { userId: 'u-ali', personName: 'Ahmed Ali' }),
      ext('e5', '105', { callerIdName: 'Ahmed Ali' }),
    ];
    expect(suggestMappings(full, people)).toEqual([]);
  });

  it('a better name wins; equal fits for one person suggest neither', () => {
    const better = [
      ext('e1', '101', { callerIdName: 'Fatima' }),
      ext('e2', '102', { callerIdName: 'Fatima Al Zahra' }),
    ];
    expect(suggestMappings(better, ws)).toEqual([
      { extensionId: 'e2', userId: 'u-fatima', name: 'Fatima Al Zahra' },
    ]);
    const tie = [
      ext('e1', '101', { callerIdName: 'Ravi' }),
      ext('e2', '102', { callerIdName: 'ravi' }),
    ];
    expect(suggestMappings(tie, ws)).toEqual([]);
  });

  it('stays inside the extension’s own workspace, and only workspaces I administer', () => {
    const rows = [
      ext('e1', '201', { accountId: B, callerIdName: 'Fatima Al Zahra' }),
      ext('e2', '202', { accountId: B, callerIdName: 'Sara' }),
      ext('e3', '301', { accountId: 'acct-c', callerIdName: 'Ravi' }),
    ];
    expect(suggestMappings(rows, ws)).toEqual([
      { extensionId: 'e2', userId: 'u-sara', name: 'Sara' },
    ]);
  });
});

describe('filterExtensions', () => {
  const rows = [
    ext('e3', '1010', { callerIdName: 'Reception' }),
    ext('e1', '102', { userId: 'u-ravi', personName: 'Ravi Kumar' }),
    ext('e2', '99', { callerIdName: 'Fatima' }),
  ];
  it('sorts numerically and filters linked / unlinked', () => {
    expect(filterExtensions(rows, '', 'all').map((r) => r.extension)).toEqual([
      '99',
      '102',
      '1010',
    ]);
    expect(filterExtensions(rows, '', 'linked').map((r) => r.id)).toEqual([
      'e1',
    ]);
    expect(filterExtensions(rows, '', 'unlinked').map((r) => r.id)).toEqual([
      'e2',
      'e3',
    ]);
  });
  it('searches number, PBX name and person', () => {
    expect(filterExtensions(rows, '10', 'all').map((r) => r.id)).toEqual([
      'e1',
      'e3',
    ]);
    expect(filterExtensions(rows, 'recep', 'all').map((r) => r.id)).toEqual([
      'e3',
    ]);
    expect(filterExtensions(rows, 'kumar', 'all').map((r) => r.id)).toEqual([
      'e1',
    ]);
  });
});

describe('people side', () => {
  const rows = [
    ext('e1', '101', { userId: 'u-ravi', personName: 'Ravi Kumar' }),
    ext('e2', '102'),
    ext('e3', '103'),
    ext('e4', '201', { accountId: B }),
    ext('e9', '900', { accountId: 'acct-c', userId: 'u-x', mapped: true }),
  ];

  it('lists people without an extension first', () => {
    const list = peopleRows(rows, ws);
    expect(list).toHaveLength(6);
    expect(list.at(-1)).toMatchObject({
      userId: 'u-ravi',
      extension: { id: 'e1' },
    });
    expect(list.slice(0, -1).every((r) => r.extension === null)).toBe(true);
  });

  it('person options mark who already holds another extension', () => {
    const opts = personOptions(rows[1], rows, ws);
    expect(opts.at(-1)).toEqual({
      userId: 'u-ravi',
      name: 'Ravi Kumar',
      holds: '101',
      holdsId: 'e1',
    });
    // On their own extension they are not "holding another".
    expect(
      personOptions(rows[0], rows, ws).find((o) => o.userId === 'u-ravi')
    ).toMatchObject({ holds: null, holdsId: null });
    expect(personOptions(rows[4], rows, ws)).toEqual([]);
  });

  it('free extensions are the workspace’s unlinked ones', () => {
    expect(freeExtensions(rows, A).map((r) => r.id)).toEqual(['e2', 'e3']);
    expect(freeExtensions(rows, B).map((r) => r.id)).toEqual(['e4']);
  });

  it('summary counts only my workspaces', () => {
    expect(mappingSummary(rows, ws)).toEqual({
      total: 4,
      linked: 1,
      unlinked: 3,
      peopleWithout: 5,
    });
  });
});

describe('planLink', () => {
  const rows = [
    ext('e1', '101', { userId: 'u1' }),
    ext('e2', '102'),
    ext('e3', '103', { accountId: B, userId: 'u2' }),
    ext('e4', '104', { mapped: true }), // linked in a workspace we do not see
  ];

  it('links a person who holds nothing in one step', () => {
    expect(planLink('e2', 'u9', rows)).toEqual([
      { extensionId: 'e2', userId: 'u9' },
    ]);
  });

  it('moves a person: unlinks their old extension first', () => {
    expect(planLink('e2', 'u1', rows)).toEqual([
      { extensionId: 'e1', userId: null },
      { extensionId: 'e2', userId: 'u1' },
    ]);
  });

  it('ignores what the person holds in another workspace', () => {
    expect(planLink('e2', 'u2', rows)).toEqual([
      { extensionId: 'e2', userId: 'u2' },
    ]);
  });

  it('does nothing for the person already there', () => {
    expect(planLink('e1', 'u1', rows)).toEqual([]);
  });

  it('unlinks a linked extension, and nothing for an unlinked one', () => {
    expect(planLink('e1', null, rows)).toEqual([
      { extensionId: 'e1', userId: null },
    ]);
    expect(planLink('e4', null, rows)).toEqual([
      { extensionId: 'e4', userId: null },
    ]);
    expect(planLink('e2', null, rows)).toEqual([]);
  });

  it('does nothing for an unknown extension', () => {
    expect(planLink('nope', 'u1', rows)).toEqual([]);
  });
});

describe('suggestionStillValid', () => {
  const rows = [
    ext('e1', '101', { userId: 'u1' }),
    ext('e2', '102'),
    ext('e3', '103', { accountId: B, userId: 'u2' }),
  ];
  it('holds for a free extension and a person with none there', () => {
    expect(
      suggestionStillValid({ extensionId: 'e2', userId: 'u2' }, rows)
    ).toBe(true);
  });
  it('fails once the extension was linked meanwhile', () => {
    const now = [...rows.slice(0, 1), ext('e2', '102', { userId: 'u9' })];
    expect(suggestionStillValid({ extensionId: 'e2', userId: 'u2' }, now)).toBe(
      false
    );
  });
  it('fails for a person who now holds an extension there (no moves)', () => {
    expect(
      suggestionStillValid({ extensionId: 'e2', userId: 'u1' }, rows)
    ).toBe(false);
  });
  it('fails for a mapped row with no person, and an unknown extension', () => {
    const now = [ext('e2', '102', { mapped: true })];
    expect(suggestionStillValid({ extensionId: 'e2', userId: 'u2' }, now)).toBe(
      false
    );
    expect(suggestionStillValid({ extensionId: 'x', userId: 'u2' }, now)).toBe(
      false
    );
  });
});

describe('mergeSynced', () => {
  const local = [
    { ...ext('e1', '101', { userId: 'u1' }), onPbx: true },
    { ...ext('e2', '102'), onPbx: true },
  ];
  const synced = [
    { ...ext('e1', '101', { callerIdName: 'Pbx One' }), onPbx: false },
    {
      ...ext('e2', '102', { userId: 'u7', callerIdName: 'Pbx Two' }),
      onPbx: true,
    },
    { ...ext('e3', '103', { callerIdName: 'New' }), onPbx: true },
  ];
  it('keeps a row written since the sync began, with the PBX name', () => {
    const out = mergeSynced(local, synced, (id) => id === 'e1');
    expect(out[0]).toMatchObject({
      userId: 'u1',
      callerIdName: 'Pbx One',
      onPbx: false,
    });
    expect(out[1]).toBe(synced[1]);
    expect(out.map((r) => r.id)).toEqual(['e1', 'e2', 'e3']);
  });
  it('takes the sync for every row when nothing was written', () => {
    expect(mergeSynced(local, synced, () => false)).toEqual(synced);
  });
});

describe('withPbxFields', () => {
  it('keeps the PBX name a sync gave the row while a PATCH was out', () => {
    const server = {
      id: 'e1',
      userId: 'u',
      callerIdName: undefined,
      onPbx: undefined,
    };
    const now = { id: 'e1', userId: null, callerIdName: 'Fatima', onPbx: true };
    expect(withPbxFields(server, now)).toEqual({
      id: 'e1',
      userId: 'u',
      callerIdName: 'Fatima',
      onPbx: true,
    });
  });
});

describe('personKey', () => {
  it('never collides with an extension id', () => {
    expect(personKey('a', 'u')).toBe('person:a:u');
  });
});
