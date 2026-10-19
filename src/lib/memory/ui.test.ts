import { describe, expect, it } from 'vitest';

import {
  appendPage,
  canRevealFrom,
  memoryListUrl,
  memorySegments,
  nextBefore,
  parseMemoryItems,
  refusalMessageKey,
  revealErrorKey,
  saveErrorKey,
  type MemoryItemView,
} from './ui';

const TOKEN = 'vlt_' + 'kmnpqrstvwxyzghjkmnpqrstvw';

describe('parseMemoryItems', () => {
  it('reads a list item', () => {
    const [item] = parseMemoryItems({
      items: [
        {
          id: 'm1',
          kind: 'decision',
          content: 'Agreed a 3-month deferral',
          importance: 4,
          trust: 'verified',
          sourceType: 'staff',
          sourceId: null,
          createdBy: 'u1',
          createdAt: '2026-10-18T10:00:00.000Z',
          expiresAt: '2027-10-18T10:00:00.000Z',
          recallCount: 0,
          lastRecalledAt: null,
        },
      ],
    });
    expect(item).toEqual({
      id: 'm1',
      kind: 'decision',
      content: 'Agreed a 3-month deferral',
      importance: 4,
      trust: 'verified',
      sourceType: 'staff',
      createdBy: 'u1',
      createdAt: '2026-10-18T10:00:00.000Z',
      expiresAt: '2027-10-18T10:00:00.000Z',
      rank: null,
    });
  });

  it('reads a search item, which has rank and no list-only fields', () => {
    const [item] = parseMemoryItems({
      items: [
        {
          id: 'm2',
          kind: 'fact',
          content: 'x',
          importance: 2,
          trust: 'untrusted',
          createdAt: '2026-10-18T10:00:00.000Z',
          rank: 0.42,
        },
      ],
    });
    expect(item?.rank).toBe(0.42);
    expect(item?.createdBy).toBeNull();
    expect(item?.expiresAt).toBeNull();
  });

  it('defaults what is malformed and drops entries without id or content', () => {
    const items = parseMemoryItems({
      items: [
        { id: 'a', content: 'ok', kind: 'nonsense', trust: 'VERIFIED' },
        { id: 'b', content: 'ok', importance: 9, createdAt: 'not a date' },
        { id: 'c', content: 'ok', importance: 0 },
        { content: 'no id' },
        { id: 'd' },
        null,
        'string',
      ],
    });
    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(items[0]).toMatchObject({
      kind: null,
      trust: 'untrusted',
      importance: 3,
    });
    expect(items[1]).toMatchObject({ importance: 5, createdAt: null });
    expect(items[2]?.importance).toBe(1);
  });

  it('answers an empty list for anything but { items: [] }', () => {
    expect(parseMemoryItems(null)).toEqual([]);
    expect(parseMemoryItems({ items: 'x' })).toEqual([]);
    expect(parseMemoryItems([])).toEqual([]);
  });
});

describe('memorySegments', () => {
  it('keeps plain text as one segment', () => {
    expect(memorySegments('Prefers calls after 5pm')).toEqual([
      { type: 'text', text: 'Prefers calls after 5pm' },
    ]);
    expect(memorySegments('')).toEqual([]);
  });

  it('splits vault tokens into token segments with the bare token', () => {
    expect(memorySegments(`EID [EID:${TOKEN}] on file.`)).toEqual([
      { type: 'text', text: 'EID ' },
      { type: 'token', kind: 'EID', token: TOKEN },
      { type: 'text', text: ' on file.' },
    ]);
    for (const kind of [
      'IBAN',
      'PASSPORT',
      'PHONE',
      'ACCOUNT',
      'TRADE_LICENCE',
    ])
      expect(memorySegments(`[${kind}:${TOKEN}]`)).toEqual([
        { type: 'token', kind, token: TOKEN },
      ]);
  });

  it('splits redaction markers, keeping a phone marker’s digits', () => {
    expect(
      memorySegments('card [CARD], otp [OTP], mail [EMAIL], tel [PHONE:567]')
    ).toEqual([
      { type: 'text', text: 'card ' },
      { type: 'redaction', kind: 'CARD', last: null },
      { type: 'text', text: ', otp ' },
      { type: 'redaction', kind: 'OTP', last: null },
      { type: 'text', text: ', mail ' },
      { type: 'redaction', kind: 'EMAIL', last: null },
      { type: 'text', text: ', tel ' },
      { type: 'redaction', kind: 'PHONE', last: '567' },
    ]);
    for (const kind of ['IBAN', 'EID', 'ACCT', 'PASSPORT'])
      expect(memorySegments(`[${kind}]`)).toEqual([
        { type: 'redaction', kind, last: null },
      ]);
  });

  it('leaves look-alikes as text', () => {
    for (const s of [
      '[EID:vlt_short]',
      `[EID:${TOKEN.replace('k', 'a')}]`, // 'a' is outside the alphabet
      `[NAME:${TOKEN}]`,
      '[PHONE:12345]',
      '[PHONE]',
      '[card]',
      `EID:${TOKEN}`,
    ])
      expect(memorySegments(s)).toEqual([{ type: 'text', text: s }]);
  });

  it('handles adjacent markers and markup-looking text as text', () => {
    expect(memorySegments(`[CARD][IBAN:${TOKEN}]<b>x</b>`)).toEqual([
      { type: 'redaction', kind: 'CARD', last: null },
      { type: 'token', kind: 'IBAN', token: TOKEN },
      { type: 'text', text: '<b>x</b>' },
    ]);
  });
});

describe('refusalMessageKey / saveErrorKey', () => {
  it('maps every refusal code the API sends', () => {
    expect(refusalMessageKey('TOKENIZE_FAILED')).toBe('tokenizeFailed');
    expect(refusalMessageKey('EMPTY')).toBe('empty');
    expect(refusalMessageKey('TOO_LONG')).toBe('tooLong');
    expect(refusalMessageKey('SUPERSEDE_VERIFIED')).toBe('supersedeVerified');
    expect(refusalMessageKey('SCOPE_INVALID')).toBe('scopeInvalid');
    expect(refusalMessageKey('REDACTION_REFUSED')).toBe('redactionRefused');
  });

  it('answers unknown for anything else', () => {
    for (const c of ['toString', 'NOPE', undefined, null, 3])
      expect(refusalMessageKey(c)).toBe('unknown');
  });

  it('routes a POST failure by status', () => {
    expect(saveErrorKey(422, 'EMPTY')).toBe('refusals.empty');
    expect(saveErrorKey(403, undefined)).toBe('errors.forbidden');
    expect(saveErrorKey(404, undefined)).toBe('errors.notFound');
    expect(saveErrorKey(400, undefined)).toBe('errors.invalid');
    expect(saveErrorKey(500, undefined)).toBe('errors.saveFailed');
    expect(saveErrorKey(0, undefined)).toBe('errors.saveFailed');
  });
});

describe('revealErrorKey / canRevealFrom', () => {
  it('maps the reveal refusals', () => {
    expect(revealErrorKey(403, 'DENIED')).toBe('denied');
    expect(revealErrorKey(403, undefined)).toBe('denied');
    expect(revealErrorKey(404, 'NOT_FOUND')).toBe('notFound');
    expect(revealErrorKey(429, 'RATE_LIMITED')).toBe('rateLimited');
    expect(revealErrorKey(409, 'DECRYPT_FAILED')).toBe('decryptFailed');
    expect(revealErrorKey(503, 'VAULT_NOT_CONFIGURED')).toBe('notConfigured');
    expect(revealErrorKey(400, undefined)).toBe('reasonRefused');
    expect(revealErrorKey(500, undefined)).toBe('failed');
  });

  it('allows reveal only with a configured vault and a vault role', () => {
    expect(
      canRevealFrom({ configured: true, overview: { myRole: 'admin' } })
    ).toBe(true);
    expect(
      canRevealFrom({ configured: true, overview: { myRole: 'super_admin' } })
    ).toBe(true);
    expect(
      canRevealFrom({ configured: true, overview: { myRole: null } })
    ).toBe(false);
    expect(
      canRevealFrom({ configured: false, overview: { myRole: 'admin' } })
    ).toBe(false);
    expect(canRevealFrom({ error: 'Forbidden' })).toBe(false);
    expect(canRevealFrom(null)).toBe(false);
  });
});

describe('paging', () => {
  const item = (id: string, createdAt: string | null): MemoryItemView => ({
    id,
    kind: 'fact',
    content: id,
    importance: 3,
    trust: 'verified',
    sourceType: null,
    createdBy: null,
    createdAt,
    expiresAt: null,
    rank: null,
  });

  it('builds the list and search URLs', () => {
    expect(memoryListUrl('/api/cases/c1/memory', { limit: 20 })).toBe(
      '/api/cases/c1/memory?limit=20'
    );
    expect(
      memoryListUrl('/api/cases/c1/memory', {
        before: '2026-10-18T10:00:00.000Z',
        limit: 20,
      })
    ).toBe('/api/cases/c1/memory?before=2026-10-18T10%3A00%3A00.000Z&limit=20');
    // A search does not page: before is ignored.
    expect(
      memoryListUrl('/api/contacts/k/memory', {
        q: '  deferral & rate ',
        before: 'x',
        limit: 20,
      })
    ).toBe('/api/contacts/k/memory?q=deferral+%26+rate&limit=20');
  });

  it('pages from the oldest item and drops repeats', () => {
    const page = [
      item('a', '2026-10-18T10:00:00.000Z'),
      item('b', '2026-10-17T10:00:00.000Z'),
      item('c', null),
    ];
    expect(nextBefore(page)).toBe('2026-10-17T10:00:00.000Z');
    expect(nextBefore([])).toBeNull();
    expect(
      appendPage(page, [item('b', null), item('d', null)]).map((i) => i.id)
    ).toEqual(['a', 'b', 'c', 'd']);
  });
});
