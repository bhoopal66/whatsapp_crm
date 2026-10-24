import { describe, expect, it } from 'vitest';

import { SgHttpError } from './http';
import type { SubmissionGroup } from './store';
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  cursorFilter,
  decodeCursor,
  encodeCursor,
  myLabelOf,
  nextCursor,
  parseListQuery,
  searchFilter,
  searchTerm,
  toChannelRef,
  toDetailGroup,
  toListItem,
} from './views';

const GID = '11111111-1111-4111-8111-111111111111';

const group = (over: Partial<SubmissionGroup> = {}): SubmissionGroup => ({
  id: 'g1',
  accountId: 'acct-1',
  submissionRef: 'SUB-1',
  contactId: 'c1',
  channelId: 'w1',
  waMode: 'group',
  subject: 'Jane · SUB-1',
  coordinatorPhone: null,
  status: 'ACTIVE',
  waGroupId: null,
  inviteLink: null,
  submissionStatus: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  lastActivityAt: new Date('2026-10-10T00:00:00Z'),
  endedAt: null,
  endReason: null,
  waCreateError: null,
  waClosedAt: null,
  waCloseError: null,
  inviteSentAt: null,
  inviteSendError: null,
  ...over,
});

const qs = (s: string) => parseListQuery(new URLSearchParams(s));

describe('parseListQuery', () => {
  it('defaults to the first page of ACTIVE groups', () => {
    expect(qs('')).toEqual({
      status: 'ACTIVE',
      search: null,
      cursor: null,
      limit: LIST_LIMIT_DEFAULT,
    });
  });

  it('reads status, cursor and a clamped limit', () => {
    const cursor = { at: '2026-10-10T00:00:00.000Z', id: GID };
    const raw = encodeURIComponent(encodeCursor(cursor));
    expect(qs(`status=ENDED&cursor=${raw}&limit=500`)).toEqual({
      status: 'ENDED',
      search: null,
      cursor,
      limit: LIST_LIMIT_MAX,
    });
    expect(qs('limit=0').limit).toBe(1);
    expect(qs('limit=abc').limit).toBe(LIST_LIMIT_DEFAULT);
  });

  it('refuses an unknown status or an unparseable cursor', () => {
    expect(() => qs('status=open')).toThrow(SgHttpError);
    expect(() => qs('cursor=soon')).toThrow(SgHttpError);
    const enc = (v: string) => Buffer.from(v).toString('base64url');
    for (const bad of [
      '2026-10-10T00:00:00.000Z', // the old timestamp-only cursor
      enc('2026-10-10T00:00:00.000Z'),
      enc(`nope|${GID}`),
      enc('2026-10-10T00:00:00.000Z|g1'),
      enc(`2026-10-10T00:00:00.000Z|${GID}|x`),
      enc(`2026-10-10|${GID}`),
      enc(`2026-10-10T00:00:00.1234567Z|${GID}`), // 7 fractional digits
      enc(`2026-10-10T00:00:00+0000|${GID}`), // offset without a colon
      enc(`2026-10-10 00:00:00Z|${GID}`), // no T
      enc(`2026-13-45T00:00:00Z|${GID}`), // not a date
      // Filter syntax smuggled into the timestamp never reaches or().
      enc(`2026-10-10T00:00:00Z,id.gt.0|${GID}`),
      enc(`2026-10-10T00:00:00Z (x),or(id.gt.0)|${GID}`),
    ])
      expect(() => qs(`cursor=${bad}`)).toThrow(SgHttpError);
  });
});

describe('cursor', () => {
  it('round-trips and builds the keyset filter', () => {
    const c = { at: '2026-10-10T00:00:00.000Z', id: GID };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(cursorFilter('ended_at', c)).toBe(
      `ended_at.lt.${c.at},and(ended_at.eq.${c.at},id.lt.${GID})`
    );
  });

  it('keeps a PostgREST timestamp byte for byte, microseconds and offset', () => {
    for (const at of [
      '2026-10-16T10:00:00.123456+00:00',
      '2026-10-16T14:00:00.1+04:00',
      '2026-10-16T10:00:00-05:30',
      '2026-10-16T10:00:00Z',
    ]) {
      const c = { at, id: GID };
      expect(decodeCursor(encodeCursor(c))).toEqual(c);
      expect(cursorFilter('last_activity_at', c)).toBe(
        `last_activity_at.lt.${at},and(last_activity_at.eq.${at},id.lt.${GID})`
      );
    }
  });
});

describe('searchTerm', () => {
  it('turns filter syntax into one-character wildcards', () => {
    expect(searchTerm('  SUB,1).or(id  ')).toBe('SUB_1__or_id');
    expect(searchTerm('Jane   Doe')).toBe('Jane Doe');
    expect(searchTerm('عمر')).toBe('عمر');
  });

  it('is no search without a letter or digit', () => {
    expect(searchTerm('')).toBeNull();
    expect(searchTerm('*%,()')).toBeNull();
    expect(searchTerm(null)).toBeNull();
  });

  it('caps the term', () => {
    expect(searchTerm('a'.repeat(500))).toHaveLength(64);
  });
});

describe('searchFilter', () => {
  it('matches the ref, plus matched contacts when there are any', () => {
    expect(searchFilter('ab', [])).toBe('submission_ref.ilike.*ab*');
    expect(searchFilter('ab', ['c1', 'c2'])).toBe(
      'submission_ref.ilike.*ab*,contact_id.in.(c1,c2)'
    );
  });
});

describe('nextCursor', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'g1',
    last_activity_at: '2026-10-10T00:00:00+00:00',
    ended_at: null,
    ...over,
  });

  it('names the last scanned row only when the page was full', () => {
    const rows = [
      row(),
      row({ id: GID, last_activity_at: '2026-10-09T00:00:00.123456+00:00' }),
    ];
    expect(decodeCursor(nextCursor(rows, 2, 'ACTIVE')!)).toEqual({
      at: '2026-10-09T00:00:00.123456+00:00',
      id: GID,
    });
    expect(nextCursor(rows, 3, 'ACTIVE')).toBeNull();
    const ended = [row({ id: GID, ended_at: '2026-10-12T00:00:00.5+00:00' })];
    expect(decodeCursor(nextCursor(ended, 1, 'ENDED')!)).toEqual({
      at: '2026-10-12T00:00:00.5+00:00',
      id: GID,
    });
    expect(nextCursor([row()], 1, 'ENDED')).toBeNull();
  });
});

describe('myLabelOf', () => {
  it('reads the open row on an ACTIVE group', () => {
    const rows = [
      { group_id: 'g1', label: 'team_lead', removed_at: '2026-10-02' },
      { group_id: 'g1', label: 'agent', removed_at: null },
    ];
    expect(myLabelOf(group(), rows)).toBe('agent');
    expect(myLabelOf(group({ id: 'g2' }), rows)).toBeNull();
  });

  it('reads the row closed at the end on an ENDED group', () => {
    const g = group({ status: 'ENDED', endedAt: new Date('2026-10-12Z') });
    expect(
      myLabelOf(g, [
        { group_id: 'g1', label: 'agent', removed_at: '2026-10-05Z' },
        {
          group_id: 'g1',
          label: 'coordinator',
          removed_at: '2026-10-12T00:00:00+00:00',
        },
      ])
    ).toBe('coordinator');
    expect(
      myLabelOf(g, [
        { group_id: 'g1', label: 'agent', removed_at: '2026-10-05Z' },
      ])
    ).toBeNull();
  });
});

describe('toChannelRef', () => {
  it('prefers the label, then the phone, then a generic name', () => {
    expect(
      toChannelRef({ id: 'w', label: 'Sales', waba_id: '971' }).label
    ).toBe('Sales');
    expect(toChannelRef({ id: 'w', label: ' ', waba_id: '971' }).label).toBe(
      '971'
    );
    expect(toChannelRef({ id: 'w', label: null, waba_id: null }).label).toBe(
      'Number'
    );
  });
});

describe('toListItem', () => {
  const refs = {
    contacts: new Map([['c1', { id: 'c1', name: 'Jane', phone: '9715' }]]),
    channels: new Map([['w1', { id: 'w1', label: 'Sales' }]]),
    myLabel: null,
  };

  it('marks an ACTIVE group without a WhatsApp group pending', () => {
    expect(toListItem(group(), refs)).toMatchObject({
      pending: true,
      archive: false,
      contact: { id: 'c1', name: 'Jane', phone: '9715' },
      channel: { id: 'w1', label: 'Sales' },
      ended_at: null,
    });
  });

  it('never marks a wa_mode none row pending, and exposes wa_mode', () => {
    const none = group({ waMode: 'none', channelId: null });
    expect(toListItem(none, refs)).toMatchObject({
      wa_mode: 'none',
      pending: false,
      channel: null,
    });
    expect(toDetailGroup(none, refs)).toMatchObject({
      wa_mode: 'none',
      pending: false,
    });
    expect(toListItem(group(), refs)).toMatchObject({ wa_mode: 'group' });
  });

  it('answers a deleted contact or number as null, and an ENDED group as archive', () => {
    const item = toListItem(
      group({
        contactId: null,
        channelId: null,
        status: 'ENDED',
        endedAt: new Date('2026-10-12Z'),
        endReason: 'idle',
      }),
      refs
    );
    expect(item).toMatchObject({
      contact: null,
      channel: null,
      pending: false,
      archive: true,
      ended_at: '2026-10-12T00:00:00.000Z',
      end_reason: 'idle',
    });
  });
});
