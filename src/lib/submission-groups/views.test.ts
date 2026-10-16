import { describe, expect, it } from 'vitest';

import { SgHttpError } from './http';
import type { SubmissionGroup } from './store';
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  myLabelOf,
  nextCursor,
  parseListQuery,
  searchFilter,
  searchTerm,
  toChannelRef,
  toListItem,
} from './views';

const group = (over: Partial<SubmissionGroup> = {}): SubmissionGroup => ({
  id: 'g1',
  accountId: 'acct-1',
  submissionRef: 'SUB-1',
  contactId: 'c1',
  channelId: 'w1',
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
    expect(qs('status=ENDED&cursor=2026-10-10T00:00:00Z&limit=500')).toEqual({
      status: 'ENDED',
      search: null,
      cursor: '2026-10-10T00:00:00.000Z',
      limit: LIST_LIMIT_MAX,
    });
    expect(qs('limit=0').limit).toBe(1);
    expect(qs('limit=abc').limit).toBe(LIST_LIMIT_DEFAULT);
  });

  it('refuses an unknown status or an unparseable cursor', () => {
    expect(() => qs('status=open')).toThrow(SgHttpError);
    expect(() => qs('cursor=soon')).toThrow(SgHttpError);
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
  it('names the last scanned row only when the page was full', () => {
    const rows = [group(), group({ lastActivityAt: new Date('2026-10-09Z') })];
    expect(nextCursor(rows, 2, 'ACTIVE')).toBe('2026-10-09T00:00:00.000Z');
    expect(nextCursor(rows, 3, 'ACTIVE')).toBeNull();
    const ended = [
      group({ status: 'ENDED', endedAt: new Date('2026-10-12Z') }),
    ];
    expect(nextCursor(ended, 1, 'ENDED')).toBe('2026-10-12T00:00:00.000Z');
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
