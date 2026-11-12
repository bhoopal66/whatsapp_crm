import { describe, expect, it } from 'vitest';

import { SgHttpError } from './http';
import type { GroupMessage, SubmissionGroup } from './store';
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  cursorFilter,
  decodeCursor,
  encodeCursor,
  bankHolderLabel,
  impliedLabel,
  myLabelOf,
  nextCursor,
  parseListQuery,
  scanVisiblePage,
  searchFilter,
  searchTerm,
  toChannelRef,
  toDetailGroup,
  toListItem,
  toMessageView,
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
  customerName: null,
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
      bank: null,
    });
  });

  it('reads a bank code, upper-cased, and refuses anything else', () => {
    expect(qs('bank=fab').bank).toBe('FAB');
    expect(qs('bank=%20RAK_BANK2%20').bank).toBe('RAK_BANK2');
    expect(qs('bank=').bank).toBeNull();
    for (const bad of ['F', 'a%2Cb', 'FAB)', 'A'.repeat(33), 'FA%20B'])
      expect(() => qs(`bank=${bad}`)).toThrow(SgHttpError);
  });

  it('reads status, cursor and a clamped limit', () => {
    const cursor = { at: '2026-10-10T00:00:00.000Z', id: GID };
    const raw = encodeURIComponent(encodeCursor(cursor));
    expect(qs(`status=ENDED&cursor=${raw}&limit=500`)).toEqual({
      status: 'ENDED',
      search: null,
      cursor,
      limit: LIST_LIMIT_MAX,
      bank: null,
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
    expect(searchFilter('ab', [])).toBe(
      'submission_ref.ilike.*ab*,customer_name.ilike.*ab*'
    );
    expect(searchFilter('ab', ['c1', 'c2'])).toBe(
      'submission_ref.ilike.*ab*,customer_name.ilike.*ab*,contact_id.in.(c1,c2)'
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

describe('scanVisiblePage', () => {
  // Ten rows, newest first, as the scan's (column desc, id desc) order has them.
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: `id-${i}`,
    last_activity_at: `2026-11-12T10:00:${String(59 - i).padStart(2, '0')}+00:00`,
  }));
  const at = (i: number) => ({ at: rows[i].last_activity_at, id: rows[i].id });

  /** A keyset scan over `pool` and a visibility check, both recorded. */
  const harness = (shown: number[], pool = rows, batch = 3) => {
    const scans: (string | null)[] = [];
    const checks: string[][] = [];
    return {
      scans,
      checks,
      scan: async (after: { id: string } | null) => {
        scans.push(after?.id ?? null);
        const from = after ? pool.findIndex((r) => r.id === after.id) + 1 : 0;
        return pool.slice(from, from + batch);
      },
      visible: async (ids: string[]) => {
        checks.push(ids);
        return new Set(ids.filter((id) => shown.includes(Number(id.slice(3)))));
      },
    };
  };
  const run = (
    h: ReturnType<typeof harness>,
    over: { limit?: number; rounds?: number; cursor?: ReturnType<typeof at> }
  ) =>
    scanVisiblePage({
      column: 'last_activity_at',
      cursor: over.cursor ?? null,
      limit: over.limit ?? 3,
      scan: h.scan,
      visible: h.visible,
      batch: 3,
      rounds: over.rounds ?? 5,
    });

  it('fills a page across batches, skipping rows the caller cannot see', async () => {
    const h = harness([1, 4, 5, 8]);
    const page = await run(h, {});
    expect(page.rows.map((r) => r.id)).toEqual(['id-1', 'id-4', 'id-5']);
    // The next page starts after the last row shown, not the batch's end.
    expect(page.next).toEqual(at(5));
    expect(h.scans).toEqual([null, 'id-2']);
    expect(h.checks.every((ids) => ids.length <= 3)).toBe(true);
  });

  it('starts after the given cursor and ends when the scan runs out', async () => {
    const h = harness([1, 8]);
    const page = await run(h, { cursor: at(2) });
    expect(page.rows.map((r) => r.id)).toEqual(['id-8']);
    expect(page.next).toBeNull();
    expect(h.scans).toEqual(['id-2', 'id-5', 'id-8']);
  });

  it('answers what it found, with a cursor, once the rounds are spent', async () => {
    const h = harness([9]);
    const page = await run(h, { rounds: 2 });
    expect(page.rows).toEqual([]);
    expect(page.next).toEqual(at(5));
  });

  it('has no next page when the page fills on the last row there is', async () => {
    const h = harness([3, 4], rows.slice(0, 5));
    const page = await run(h, { limit: 2 });
    expect(page.rows.map((r) => r.id)).toEqual(['id-3', 'id-4']);
    expect(page.next).toBeNull();
  });

  it('answers an empty page for an empty scan', async () => {
    const h = harness([], []);
    expect(await run(h, {})).toEqual({ rows: [], next: null });
    expect(h.checks).toEqual([]);
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

  it("carries the tracker's customer name and status word", () => {
    const g = group({
      customerName: 'Acme Trading LLC',
      submissionStatus: 'Inhouse Review',
    });
    expect(toListItem(g, refs)).toMatchObject({
      customer_name: 'Acme Trading LLC',
      submission_status: 'Inhouse Review',
      contact: { name: 'Jane' },
    });
    expect(toDetailGroup(g, refs)).toMatchObject({
      customer_name: 'Acme Trading LLC',
      submission_status: 'Inhouse Review',
    });
    expect(toListItem(group(), refs)).toMatchObject({
      customer_name: null,
      submission_status: null,
    });
  });

  it("carries the case's bank, null for a group with none", () => {
    const fab = { code: 'FAB', name: 'First Abu Dhabi Bank (FAB)' };
    const banks = new Map([['g1', fab]]);
    expect(toListItem(group(), { ...refs, banks }).bank).toEqual(fab);
    expect(toDetailGroup(group(), { ...refs, banks }).bank).toEqual(fab);
    expect(toListItem(group({ id: 'g2' }), { ...refs, banks }).bank).toBeNull();
    expect(toListItem(group(), refs).bank).toBeNull();
  });

  it('lists every coordinator number once, the request number first (142)', () => {
    const g = group({
      coordinatorPhone: '971500000001',
      coordinatorPhones: ['971500000002', '971500000001', '971500000003'],
    });
    expect(toDetailGroup(g, refs).coordinator_phones).toEqual([
      '971500000001',
      '971500000002',
      '971500000003',
    ]);
    expect(
      toDetailGroup(group({ coordinatorPhone: null }), refs).coordinator_phones
    ).toEqual([]);
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

describe('bankHolderLabel (163)', () => {
  const held = new Set(['ADCB']);
  const banks = new Map([['g1', 'ADCB']]);
  it('makes a holder of the case bank a coordinator of an ACTIVE group', () => {
    expect(bankHolderLabel(group(), 'agent', held, banks)).toBe('coordinator');
    expect(bankHolderLabel(group(), 'team_leader', held, banks)).toBe(
      'coordinator'
    );
  });
  it('gives nothing for another bank, no case, an ENDED group or the wrong role', () => {
    expect(
      bankHolderLabel(group(), 'agent', new Set(['FAB']), banks)
    ).toBeNull();
    expect(
      bankHolderLabel(group({ id: 'g2' }), 'agent', held, banks)
    ).toBeNull();
    expect(
      bankHolderLabel(group({ status: 'ENDED' }), 'agent', held, banks)
    ).toBeNull();
    for (const role of ['admin', 'owner', 'viewer', 'bank_guest'] as const)
      expect(bankHolderLabel(group(), role, held, banks)).toBeNull();
  });
});

describe('impliedLabel (173)', () => {
  const led = new Set(['g1']);
  const none = new Set<string>();
  const held = new Set(['ADCB']);
  const banks = new Map([['g1', 'ADCB']]);
  const noBanks = new Map<string, string>();

  it('makes a leader of the case agent team_lead of an ACTIVE group', () => {
    expect(impliedLabel(group(), 'team_leader', led, none, noBanks)).toBe(
      'team_lead'
    );
  });
  it('puts leading the agent ahead of holding the bank', () => {
    expect(impliedLabel(group(), 'team_leader', led, held, banks)).toBe(
      'team_lead'
    );
  });
  it('falls to the bank label when the group is not led', () => {
    expect(impliedLabel(group(), 'agent', none, held, banks)).toBe(
      'coordinator'
    );
    expect(impliedLabel(group(), 'agent', none, none, banks)).toBeNull();
  });
  it('gives nothing for another group, an ENDED group or the wrong role', () => {
    expect(
      impliedLabel(group({ id: 'g2' }), 'team_leader', led, none, noBanks)
    ).toBeNull();
    expect(
      impliedLabel(group({ status: 'ENDED' }), 'team_leader', led, held, banks)
    ).toBeNull();
    for (const role of ['admin', 'owner', 'viewer', 'bank_guest'] as const)
      expect(impliedLabel(group(), role, led, held, banks)).toBeNull();
  });
});

describe('toMessageView', () => {
  const base: GroupMessage = {
    id: '7',
    direction: 'out',
    senderUserId: null,
    senderWaId: null,
    senderKind: null,
    type: 'text',
    body: 'Hello 👋',
    prefixedBody: 'Hello 👋',
    media: null,
    waMessageId: 'wamid.1',
    waTimestamp: null,
    sendStatus: 'sent',
    postEnd: false,
    createdAt: new Date('2026-11-03T10:00:00Z'),
  };

  it('marks an automatic message so the list can label it', () => {
    const v = toMessageView({ ...base, systemKind: 'welcome' }, new Map());
    expect(v.system_kind).toBe('welcome');
    expect(v.sender_name).toBeNull();
  });

  it('leaves a staff or older row unmarked', () => {
    expect(toMessageView(base, new Map()).system_kind).toBeNull();
  });
});
