import { describe, expect, it } from 'vitest';

import {
  BANK_WS_CAPS,
  PIN_KINDS as SERVER_PIN_KINDS,
} from '@/lib/cases/bank-workspaces';

import {
  BANK_CAPS,
  bankTab,
  currentPins,
  errorKey,
  isOverdue,
  localToIso,
  parseActions,
  parseBankList,
  parseBankPage,
  parsePins,
  parsePosts,
  parseThreads,
  PIN_KINDS,
  threadTree,
  type BankPost,
} from './ui';

const post = (
  id: string,
  at: string,
  parent: string | null = null
): BankPost => ({
  postId: id,
  parentPostId: parent,
  authorId: 'u1',
  body: id,
  retracted: false,
  caseId: null,
  caseReadable: false,
  caseStage: null,
  caseProduct: null,
  createdAt: at,
});

describe('restated server constants', () => {
  it('match lib/cases/bank-workspaces', () => {
    expect(PIN_KINDS).toEqual(SERVER_PIN_KINDS);
    expect(BANK_CAPS).toEqual(BANK_WS_CAPS);
  });
});

describe('threadTree', () => {
  it('nests replies under their root, both in time order', () => {
    const tree = threadTree([
      post('r2', '2026-10-01T10:05:00Z'),
      post('a2', '2026-10-01T10:04:00Z', 'r1'),
      post('r1', '2026-10-01T10:00:00Z'),
      post('a1', '2026-10-01T10:01:00Z', 'r1'),
      post('b1', '2026-10-01T10:06:00Z', 'r2'),
    ]);
    expect(tree.map((n) => n.post.postId)).toEqual(['r1', 'r2']);
    expect(tree[0].replies.map((p) => p.postId)).toEqual(['a1', 'a2']);
    expect(tree[1].replies.map((p) => p.postId)).toEqual(['b1']);
  });

  it('flattens a reply to a reply to one level and keeps orphans', () => {
    const tree = threadTree([
      post('r1', '2026-10-01T10:00:00Z'),
      post('a1', '2026-10-01T10:01:00Z', 'r1'),
      post('a1x', '2026-10-01T10:02:00Z', 'a1'),
      post('o1', '2026-10-01T10:03:00Z', 'gone'),
    ]);
    expect(tree.map((n) => n.post.postId)).toEqual(['r1', 'o1']);
    expect(tree[0].replies.map((p) => p.postId)).toEqual(['a1', 'a1x']);
  });
});

describe('parsers', () => {
  it('read the list and drop unusable rows', () => {
    expect(
      parseBankList({
        workspaces: [
          {
            bankWsId: 'w1',
            bankCode: 'ADCB',
            bankName: 'ADCB Bank',
            access: 'admin',
          },
          { bankWsId: 'w2', bankCode: 'FAB', access: 'weird' },
          { bankCode: 'X' },
          'junk',
        ],
        creatable: [{ code: 'ENBD', name: 'Emirates NBD' }, { name: 'x' }],
      })
    ).toEqual({
      workspaces: [
        {
          bankWsId: 'w1',
          bankCode: 'ADCB',
          bankName: 'ADCB Bank',
          access: 'admin',
          createdAt: null,
        },
        {
          bankWsId: 'w2',
          bankCode: 'FAB',
          bankName: 'FAB',
          access: 'member',
          createdAt: null,
        },
      ],
      creatable: [{ code: 'ENBD', name: 'Emirates NBD' }],
    });
    expect(parseBankList(null)).toEqual({ workspaces: [], creatable: [] });
    expect(parseBankPage({ cases: [] }).workspace).toBeNull();
  });

  it('never shows a retracted post body', () => {
    const [p] = parsePosts({
      posts: [{ postId: 'p', body: 'secret', retracted: true }],
    });
    expect(p.body).toBeNull();
    expect(p.retracted).toBe(true);
  });

  it('read threads, pins and actions', () => {
    expect(
      parseThreads({ threads: [{ threadId: 't', postCount: '3' }] })[0]
    ).toMatchObject({ threadId: 't', postCount: 3, actionOwnerId: null });
    expect(parsePins({ pins: [{ pinId: 'p', kind: 'nope' }] })).toEqual([]);
    expect(parseActions({ actions: [{ actionId: 'a' }] })).toEqual([]);
  });
});

describe('currentPins', () => {
  it('takes the latest version per kind and drops a cleared one', () => {
    const pins = parsePins({
      pins: [
        {
          pinId: '1',
          kind: 'bank_contacts',
          body: 'old',
          createdAt: '2026-10-01T00:00:00Z',
        },
        {
          pinId: '2',
          kind: 'bank_contacts',
          body: 'new',
          createdAt: '2026-10-02T00:00:00Z',
        },
        {
          pinId: '3',
          kind: 'known_pitfalls',
          body: 'x',
          createdAt: '2026-10-01T00:00:00Z',
        },
        {
          pinId: '4',
          kind: 'known_pitfalls',
          body: '',
          createdAt: '2026-10-03T00:00:00Z',
        },
      ],
    });
    const cur = currentPins(pins);
    expect(cur.get('bank_contacts')?.body).toBe('new');
    expect(cur.has('known_pitfalls')).toBe(false);
  });
});

describe('small helpers', () => {
  it('bankTab falls back to threads', () => {
    expect(bankTab('pinned')).toBe('pinned');
    expect(bankTab('x')).toBe('threads');
    expect(bankTab(null)).toBe('threads');
  });
  it('isOverdue and localToIso', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    expect(isOverdue('2026-10-09T00:00:00Z', now)).toBe(true);
    expect(isOverdue('2026-10-11T00:00:00Z', now)).toBe(false);
    expect(isOverdue(null, now)).toBe(false);
    expect(localToIso('')).toBeNull();
    expect(localToIso('2026-10-10T09:30')).toMatch(/^2026-10-1\dT/);
  });
  it('errorKey words 422 codes, then the status', () => {
    expect(errorKey(422, { code: 'ALREADY_MARKED' })).toBe('alreadyMarked');
    expect(errorKey(422, { code: 'LINK_INVALID' })).toBe('linkInvalid');
    expect(errorKey(403, { code: 'NOT_ALLOWED' })).toBe('notAllowed');
    expect(errorKey(404, {})).toBe('notFound');
    expect(errorKey(500, null)).toBe('failed');
  });
});
