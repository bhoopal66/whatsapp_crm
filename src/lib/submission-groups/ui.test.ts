import { describe, expect, it, vi } from 'vitest';

import { caseStatusView } from '@/lib/cases/ui';

import {
  addNumberFailure,
  AVATAR_TONES,
  avatarTone,
  bankName,
  groupContactName,
  groupTitle,
  initialsOf,
  mergeFirstPage,
  onlyMine,
  ownSendStored,
  refusedSendOutcome,
  shortRef,
  trackerStatusChip,
  waIdPhone,
  inviteNotice,
  coordinatorPhonesOf,
  addableStaff,
  staffNumberNote,
  appendPage,
  bubbleKind,
  canAddNumber,
  canResendInvite,
  canRetryCreate,
  clearUnread,
  endReasonView,
  endToastKey,
  groupBanners,
  listUrl,
  pageAfterReads,
  parseSgList,
  waModeOf,
  retryToastKey,
  sendErrorKey,
  sendStatusOf,
  sentAsPreview,
  settleRead,
  staffSenderLine,
  unreadBadgeText,
  type SgGroup,
  type SgListItem,
  type SgMessage,
} from './ui';

const item = (over: Partial<SgListItem> = {}): SgListItem => ({
  id: 'g1',
  submission_ref: 'SUB-1',
  subject: 'Home loan',
  status: 'ACTIVE',
  contact: { id: 'c1', name: 'Sara', phone: '971500000000' },
  channel: { id: 'ch1', label: 'Sales' },
  my_label: 'agent',
  last_activity_at: null,
  created_at: '2026-10-01T00:00:00Z',
  ended_at: null,
  end_reason: null,
  pending: false,
  archive: false,
  ...over,
});

const group = (over: Partial<SgGroup> = {}): SgGroup => ({
  ...item(),
  submission_status: 'SUBMITTED',
  coordinator_phone: null,
  invite_link: null,
  wa_group_id: '1203@g.us',
  wa_create_error: null,
  wa_close_error: null,
  wa_closed_at: null,
  invite_sent_at: null,
  invite_send_error: null,
  ...over,
});

describe('parseSgList', () => {
  it('reads groups and the cursor', () => {
    expect(
      parseSgList({ groups: [item(), { nope: 1 }], next_cursor: 'abc' })
    ).toEqual({
      groups: [{ ...item(), wa_mode: 'group' }],
      next_cursor: 'abc',
    });
  });

  it('reads the ended groups with new messages (308)', () => {
    const ended = item({ id: 'g9', status: 'ENDED', unread: 2 });
    expect(
      parseSgList({ groups: [], ended_unread: [ended, 'x'], next_cursor: null })
    ).toEqual({
      groups: [],
      ended_unread: [{ ...ended, wa_mode: 'group' }],
      next_cursor: null,
    });
  });

  it('survives a malformed body', () => {
    expect(parseSgList(null)).toEqual({ groups: [], next_cursor: null });
    expect(parseSgList({ groups: 'x', next_cursor: '' })).toEqual({
      groups: [],
      next_cursor: null,
    });
  });
});

describe('listUrl / appendPage', () => {
  it('builds the query, leaving out an empty search and cursor', () => {
    expect(listUrl('active', '  ', null)).toBe(
      '/api/submission-groups?status=active&limit=30'
    );
    expect(listUrl('ended', ' SUB 1 ', 'c2', { limit: 10 })).toBe(
      '/api/submission-groups?status=ended&limit=10&q=SUB+1&cursor=c2'
    );
  });

  it('adds the bank filter only when one is picked', () => {
    expect(listUrl('active', '', null, { bank: 'FAB' })).toBe(
      '/api/submission-groups?status=active&limit=30&bank=FAB'
    );
    expect(listUrl('active', '', null, { bank: null })).toBe(
      '/api/submission-groups?status=active&limit=30'
    );
  });

  it('keeps one row per id across pages', () => {
    const a = item({ id: 'a' });
    const b = item({ id: 'b' });
    expect(
      appendPage([a, b], [item({ id: 'b' }), item({ id: 'c' })]).map(
        (g) => g.id
      )
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('bubbleKind / sendStatusOf', () => {
  it('tells staff, customer, coordinator and others apart', () => {
    expect(bubbleKind({ direction: 'out', sender_kind: null })).toBe('staff');
    expect(bubbleKind({ direction: 'in', sender_kind: 'customer' })).toBe(
      'customer'
    );
    expect(bubbleKind({ direction: 'in', sender_kind: 'coordinator' })).toBe(
      'coordinator'
    );
    expect(bubbleKind({ direction: 'in', sender_kind: 'other' })).toBe('other');
    expect(bubbleKind({ direction: 'in', sender_kind: null })).toBe('other');
  });

  it('gives only staff messages a send status, pending when unset', () => {
    expect(sendStatusOf({ direction: 'in', send_status: null })).toBeNull();
    expect(sendStatusOf({ direction: 'out', send_status: null })).toBe(
      'pending'
    );
    expect(sendStatusOf({ direction: 'out', send_status: 'blocked' })).toBe(
      'blocked'
    );
  });
});

describe('staffSenderLine', () => {
  it('takes the prefix WhatsApp received', () => {
    expect(
      staffSenderLine({
        body: 'Hello',
        prefixed_body: 'Ali (Team Lead): Hello',
        sender_name: 'Ali Hassan',
      })
    ).toBe('Ali (Team Lead)');
  });

  it('falls back to the sender name', () => {
    expect(
      staffSenderLine({ body: 'Hi', prefixed_body: null, sender_name: ' Ali ' })
    ).toBe('Ali');
    expect(
      staffSenderLine({ body: 'Hi', prefixed_body: 'Hi', sender_name: null })
    ).toBeNull();
  });
});

describe('sentAsPreview', () => {
  it('matches the server prefix, with the English label', () => {
    expect(sentAsPreview('Ali  Hassan', 'coordinator')).toBe(
      'Ali Hassan (Coordinator)'
    );
    expect(sentAsPreview('Mona', 'team_lead')).toBe('Mona (Team Lead)');
  });

  it('is null without a name or label', () => {
    expect(sentAsPreview('', 'agent')).toBeNull();
    expect(sentAsPreview('Ali', null)).toBeNull();
    expect(sentAsPreview('Ali', 'owner' as never)).toBeNull();
  });
});

describe('endReasonView', () => {
  it('reads the service reasons', () => {
    expect(endReasonView('FINAL_STATUS:APPROVED')).toEqual({
      key: 'finalStatus',
      status: 'APPROVED',
    });
    expect(endReasonView('IDLE')).toEqual({ key: 'idle' });
    expect(endReasonView('MANUAL')).toEqual({ key: 'manual' });
    expect(endReasonView('NUMBER_REMOVED')).toEqual({
      key: 'other',
      raw: 'NUMBER_REMOVED',
    });
    expect(endReasonView(null)).toEqual({ key: 'none' });
  });
});

describe('ownSendStored', () => {
  const row = (id: string, over: Partial<SgMessage> = {}): SgMessage => ({
    id,
    direction: 'out',
    sender_user_id: 'me',
    sender_name: null,
    sender_wa_id: null,
    sender_kind: null,
    body: 'hi',
    prefixed_body: null,
    send_status: 'failed',
    post_end: false,
    type: 'text',
    media: null,
    created_at: '2026-11-23T08:00:00Z',
    ...over,
  });

  it('is a new row of the person who sent', () => {
    expect(ownSendStored([row('a')], [row('a'), row('b')], 'me')).toBe(true);
    expect(ownSendStored([row('a')], [row('a')], 'me')).toBe(false);
  });

  it("is not someone else's, a customer's, or an automatic one", () => {
    const others = [
      row('b', { sender_user_id: 'you' }),
      row('c', { direction: 'in', sender_user_id: null }),
      row('d', { system_kind: 'welcome' }),
    ];
    expect(ownSendStored([], others, 'me')).toBe(false);
  });
});

describe('the end and retry toasts', () => {
  it('never says ended while the WhatsApp group is open', () => {
    expect(endToastKey({ closed: true })).toBe('endDone');
    expect(endToastKey({ closed: false })).toBe('endDone');
    expect(endToastKey({ closed: false, closeDeferred: true })).toBe(
      'endCloseDeferred'
    );
    expect(endToastKey({ closed: false, closeError: 'x' })).toBe(
      'endCloseFailed'
    );
  });
  it('says what a retry did', () => {
    expect(retryToastKey(200, { pending: false })).toBe('retryDone');
    expect(retryToastKey(200, { pending: true })).toBe('retryPending');
    expect(retryToastKey(409, { code: 'number_removed' })).toBe(
      'banners.numberRemoved'
    );
    expect(retryToastKey(409, { code: 'contact_removed' })).toBe(
      'banners.contactRemoved'
    );
    expect(retryToastKey(409, null)).toBe('retryFailed');
  });
  it('shows an ended group whose WhatsApp group is open', () => {
    const ended = { status: 'ENDED', wa_group_id: 'g@g.us' } as const;
    expect(
      groupBanners(
        group({ ...ended, wa_closed_at: null, wa_close_error: null })
      )
    ).toEqual(['stillOpen']);
    expect(
      groupBanners(group({ ...ended, wa_closed_at: '2026-11-01T00:00:00Z' }))
    ).not.toContain('stillOpen');
  });
});

describe('refusedSendOutcome', () => {
  const outcome = async (
    status: number,
    body: Parameters<typeof refusedSendOutcome>[0]['body'],
    row: boolean | null,
    media = false
  ) => {
    const stored = vi.fn(async () => row);
    const out = await refusedSendOutcome({ status, body, media }, stored);
    return { ...out, asked: stored.mock.calls.length };
  };
  const gateway = { error: 'The message could not be sent' };

  it("gives the words back after nginx's own 502 that stored nothing", async () => {
    expect(await outcome(502, null, false)).toEqual({
      kept: false,
      toast: 'unknown',
      asked: 1,
    });
    expect((await outcome(502, null, false, true)).kept).toBe(false);
  });
  it('keeps what a proxy cut off after the row was stored', async () => {
    for (const status of [502, 504])
      expect(await outcome(status, null, true)).toMatchObject({
        kept: true,
        toast: 'maybeSent',
      });
  });
  it("an unreadable log: the words come back, a file's is kept", async () => {
    expect(await outcome(502, null, null)).toMatchObject({
      kept: false,
      toast: 'maybeSent',
    });
    expect((await outcome(502, null, null, true)).kept).toBe(true);
    // Our own 502 is stored, whatever the log says.
    expect((await outcome(502, gateway, null)).kept).toBe(true);
    expect((await outcome(503, gateway, null)).kept).toBe(false);
  });
  it("keeps the app's stored failure, and never gives an unconfirmed one back", async () => {
    expect(await outcome(502, gateway, true)).toMatchObject({
      kept: true,
      toast: 'gateway',
    });
    expect(
      await outcome(502, { ...gateway, code: 'send_unconfirmed' }, false)
    ).toEqual({ kept: true, toast: 'maybeSent', asked: 0 });
  });
  it('gives back what the app says was never stored, but not a stored file', async () => {
    const body = { error: 'x', code: 'not_stored' };
    expect(await outcome(503, body, true)).toEqual({
      kept: false,
      toast: 'notStored',
      asked: 0,
    });
    expect((await outcome(503, body, false, true)).kept).toBe(false);
    expect((await outcome(503, body, true, true)).kept).toBe(true);
  });
  it('keeps a consent block and gives every other refusal back', async () => {
    expect(
      await outcome(409, { error: 'x', reason: 'opted_out' }, false)
    ).toEqual({ kept: true, toast: 'optedOut', asked: 0 });
    for (const status of [400, 403, 404, 409, 429, 500])
      expect((await outcome(status, gateway, true)).kept).toBe(false);
  });
});

describe('sendErrorKey', () => {
  it('an unconfirmed send is not a refusal', () => {
    expect(sendErrorKey(502, null, 'send_unconfirmed')).toBe('maybeSent');
    expect(sendErrorKey(502)).toBe('gateway');
  });
  it('maps the API refusals', () => {
    expect(sendErrorKey(409, 'opted_out')).toBe('optedOut');
    expect(sendErrorKey(409, 'do_not_contact')).toBe('doNotContact');
    expect(sendErrorKey(409, 'something')).toBe('blocked');
    expect(sendErrorKey(409)).toBe('notReady');
    expect(sendErrorKey(429)).toBe('rateLimited');
    expect(sendErrorKey(502)).toBe('gateway');
    expect(sendErrorKey(403)).toBe('notAllowed');
    expect(sendErrorKey(404)).toBe('notFound');
    expect(sendErrorKey(400)).toBe('tooLong');
    expect(sendErrorKey(500)).toBe('unknown');
  });
});

describe('canResendInvite', () => {
  it('is not offered once the customer is in the group', () => {
    expect(canResendInvite(group({ customer_membership: 'joined' }))).toBe(
      false
    );
    expect(canResendInvite(group({ customer_membership: 'absent' }))).toBe(
      true
    );
  });

  it('offers it on an active group with a WhatsApp group, invited or not', () => {
    expect(canResendInvite(group())).toBe(true);
    expect(
      canResendInvite(group({ invite_sent_at: '2026-11-04T10:00:00Z' }))
    ).toBe(true);
  });

  it('hides it where the route would refuse for the group itself', () => {
    expect(canResendInvite(group({ status: 'ENDED' }))).toBe(false);
    expect(canResendInvite(group({ wa_mode: 'none' }))).toBe(false);
    expect(canResendInvite(group({ wa_group_id: null }))).toBe(false);
    expect(canResendInvite(group({ channel: null }))).toBe(false);
    expect(canResendInvite(group({ contact: null }))).toBe(false);
  });
});

describe('groupBanners / canRetryCreate', () => {
  it('shows nothing for a healthy group', () => {
    expect(groupBanners(group())).toEqual([]);
  });

  it('shows pending until the WhatsApp group exists', () => {
    expect(groupBanners(group({ wa_group_id: null, pending: true }))).toEqual([
      'pending',
    ]);
  });

  it('shows a create error instead of pending, and offers retry', () => {
    const g = group({ wa_group_id: null, pending: true, wa_create_error: 'x' });
    expect(groupBanners(g)).toEqual(['createError']);
    expect(canRetryCreate(g)).toBe(true);
    expect(canRetryCreate(group())).toBe(false);
    expect(canRetryCreate({ ...g, status: 'ENDED' })).toBe(false);
  });

  it('a none group shows only the info banner, no pending or number-removed', () => {
    const g = group({
      wa_mode: 'none',
      wa_group_id: null,
      pending: false,
      channel: null,
    });
    expect(groupBanners(g)).toEqual(['noWhatsapp']);
    expect(canRetryCreate({ ...g, wa_create_error: 'x' })).toBe(false);
    expect(
      groupBanners({ ...g, pending: true, wa_create_error: 'x', contact: null })
    ).toEqual(['noWhatsapp', 'contactRemoved']);
  });

  it('parses wa_mode tolerantly: missing or unknown is group', () => {
    expect(waModeOf({})).toBe('group');
    expect(waModeOf({ wa_mode: 'bogus' })).toBe('group');
    expect(waModeOf({ wa_mode: 'none' })).toBe('none');
    const page = parseSgList({
      groups: [item(), { ...item({ id: 'g2' }), wa_mode: 'none' }],
    });
    expect(page.groups.map((g) => g.wa_mode)).toEqual(['group', 'none']);
  });

  it('shows a close error only on an ENDED group not yet closed', () => {
    expect(
      groupBanners(group({ status: 'ENDED', wa_close_error: 'x' }))
    ).toEqual(['closeError']);
    expect(
      groupBanners(
        group({
          status: 'ENDED',
          wa_close_error: 'x',
          wa_closed_at: '2026-10-02T00:00:00Z',
        })
      )
    ).toEqual([]);
  });

  it('shows a removed number and contact', () => {
    expect(groupBanners(group({ channel: null, contact: null }))).toEqual([
      'numberRemoved',
      'contactRemoved',
    ]);
  });
});

describe('addableStaff', () => {
  it('lists live agents and up who are not on the list, by name', () => {
    const m = (
      user_id: string,
      account_role: string,
      extra: Record<string, unknown> = {}
    ) => ({
      user_id,
      full_name: user_id.toUpperCase(),
      account_role,
      ...extra,
    });
    expect(
      addableStaff(
        [
          m('zed', 'agent'),
          m('amy', 'team_leader'),
          m('on', 'agent'),
          m('gone', 'agent', { deactivated_at: '2026-01-01' }),
          m('view', 'viewer'),
          m('bank', 'bank_guest'),
          m('boss', 'owner'),
        ],
        [{ user_id: 'on' }]
      )
    ).toEqual([
      { id: 'amy', name: 'AMY' },
      { id: 'boss', name: 'BOSS' },
      { id: 'zed', name: 'ZED' },
    ]);
  });
});

describe('coordinatorPhonesOf', () => {
  it('lists the request number then the bank numbers, each once (142)', () => {
    expect(
      coordinatorPhonesOf({
        coordinator_phone: '971500000001',
        coordinator_phones: ['971500000002', '971500000001'],
      })
    ).toEqual(['971500000001', '971500000002']);
    expect(coordinatorPhonesOf({ coordinator_phone: '971500000001' })).toEqual([
      '971500000001',
    ]);
    expect(
      coordinatorPhonesOf({ coordinator_phone: null, coordinator_phones: [] })
    ).toEqual([]);
  });
});

describe('inviteNotice', () => {
  it('is nothing when no invite was attempted', () => {
    expect(inviteNotice(group())).toBeNull();
  });
  it('shows a sent invite with its time, even after a later failure', () => {
    const at = '2026-10-16T10:05:00.000Z';
    expect(inviteNotice(group({ invite_sent_at: at }))).toEqual({
      key: 'sent',
      at,
    });
    expect(
      inviteNotice(group({ invite_sent_at: at, invite_send_error: 'x' }))
    ).toEqual({ key: 'sent', at });
  });
  it('shows a failed invite when none went out', () => {
    expect(inviteNotice(group({ invite_send_error: 'gateway down' }))).toEqual({
      key: 'failed',
    });
  });
});

describe('bankName', () => {
  it("tags a group with its bank's name, else the code, else nothing", () => {
    expect(
      bankName({ bank: { code: 'FAB', name: ' First Abu Dhabi Bank (FAB) ' } })
    ).toBe('First Abu Dhabi Bank (FAB)');
    expect(bankName({ bank: { code: 'FAB', name: ' ' } })).toBe('FAB');
    expect(bankName({ bank: null })).toBeNull();
    // Payloads from before the bank was sent.
    expect(bankName({})).toBeNull();
  });
});

describe('group display (141)', () => {
  const contact = (name: string | null, phone: string | null = '9715') => ({
    id: 'c1',
    name,
    phone,
  });

  it('titles a group by the company, then the contact name, then the phone', () => {
    expect(
      groupTitle({ customer_name: 'Acme LLC', contact: contact('Omar') })
    ).toBe('Acme LLC');
    expect(groupTitle({ customer_name: '  ', contact: contact('Omar') })).toBe(
      'Omar'
    );
    expect(groupTitle({ contact: contact(null, '97150') })).toBe('97150');
    expect(groupTitle({ customer_name: null, contact: null })).toBeNull();
  });

  it('names the contact person only when it differs from the title', () => {
    expect(
      groupContactName({
        customer_name: 'Acme LLC',
        contact: contact('Omar'),
      })
    ).toBe('Omar');
    expect(
      groupContactName({
        customer_name: ' acme  llc ',
        contact: contact('ACME LLC'),
      })
    ).toBeNull();
    expect(
      groupContactName({ customer_name: null, contact: contact('Omar') })
    ).toBeNull();
    expect(groupContactName({ customer_name: 'Acme', contact: null })).toBe(
      null
    );
  });

  it('shortens a UUID ref to 8 characters and keeps any other ref', () => {
    expect(shortRef('c62f0c36-2afb-4184-9d7b-251143ef8a5b')).toBe('c62f0c36');
    expect(shortRef('SUB-2026-00042')).toBe('SUB-2026-00042');
  });

  it('takes up to two initials', () => {
    expect(initialsOf('Gulf Star Trading LLC')).toBe('GS');
    expect(initialsOf('acme')).toBe('A');
    expect(initialsOf('  (Al-Noor) & co ')).toBe('AC');
    expect(initialsOf('')).toBe('?');
    expect(initialsOf(null)).toBe('?');
  });

  it('gives a name the same avatar tone every time, case-blind', () => {
    expect(avatarTone('Acme LLC')).toBe(avatarTone(' acme llc '));
    expect(AVATAR_TONES).toContain(avatarTone('Acme LLC'));
    for (const tone of AVATAR_TONES) expect(tone).toMatch(/dark:text-/);
  });

  it('colours the tracker status as the case screens do', () => {
    expect(trackerStatusChip('Inhouse Review')).toEqual(
      caseStatusView({ stage: 'Submitted', submissionStatus: 'Inhouse Review' })
    );
    expect(trackerStatusChip('Something New')?.text).toBe('Something New');
    expect(trackerStatusChip(null)).toBeNull();
    expect(trackerStatusChip(' ')).toBeNull();
  });

  it('reads a WhatsApp id as a phone', () => {
    expect(waIdPhone('971501234567@c.us')).toBe('+971501234567');
    expect(waIdPhone('971501234567')).toBe('+971501234567');
    expect(waIdPhone(null)).toBeNull();
    expect(waIdPhone('@c.us')).toBeNull();
  });

  it('keeps only the groups the caller holds a label on', () => {
    const row = (id: string, my_label: 'agent' | null) =>
      ({ id, my_label }) as SgListItem;
    expect(
      onlyMine([row('a', 'agent'), row('b', null)]).map((g) => g.id)
    ).toEqual(['a']);
  });

  it('shows an unread badge only above 0, and caps it at 99+', () => {
    expect(unreadBadgeText(undefined)).toBeNull();
    expect(unreadBadgeText(0)).toBeNull();
    expect(unreadBadgeText(1)).toBe('1');
    expect(unreadBadgeText(99)).toBe('99');
    expect(unreadBadgeText(100)).toBe('99+');
  });

  it('clears the unread count of the named groups only', () => {
    const rows = [
      item({ id: 'a', unread: 4 }),
      item({ id: 'b', unread: 2 }),
      item({ id: 'c' }),
    ];
    const cleared = clearUnread(rows, new Set(['a', 'missing']));
    expect(cleared.map((g) => g.unread)).toEqual([0, 2, undefined]);
    // A pure patch: the rows handed in keep their counts.
    expect(rows[0].unread).toBe(4);
  });

  it('shows a group read meanwhile as read in both lists of a page', () => {
    const page = {
      groups: [item({ id: 'a', unread: 4 }), item({ id: 'b', unread: 1 })],
      ended_unread: [item({ id: 'e', unread: 2 })],
      next_cursor: null,
    };
    const { groups, endedUnread } = pageAfterReads(page, new Set(['a', 'e']));
    expect(groups.map((g) => g.unread)).toEqual([0, 1]);
    expect(endedUnread.map((g) => g.unread)).toEqual([0]);
    expect(
      pageAfterReads({ groups: [], next_cursor: null }, new Set()).endedUnread
    ).toEqual([]);
  });
});

describe('settleRead', () => {
  it('marks a read that falls due on screen', () => {
    expect(settleRead(true, true)).toEqual({ mark: true, owed: false });
  });

  it('holds a read that falls due while hidden, until shown', () => {
    const held = settleRead(true, false);
    expect(held).toEqual({ mark: false, owed: true });
    expect(settleRead(held.owed, false)).toEqual(held);
    expect(settleRead(held.owed, true)).toEqual({ mark: true, owed: false });
  });

  it('marks nothing on being shown with nothing owed', () => {
    expect(settleRead(false, true)).toEqual({ mark: false, owed: false });
    expect(settleRead(false, false)).toEqual({ mark: false, owed: false });
  });
});

describe('canAddNumber (211)', () => {
  it('is offered on an active WhatsApp group, the customer in it or not', () => {
    expect(canAddNumber(group())).toBe(true);
    expect(canAddNumber(group({ customer_membership: 'joined' }))).toBe(true);
    expect(canAddNumber(group({ contact: null }))).toBe(true);
  });

  it('is hidden where the route would refuse for the group itself', () => {
    expect(canAddNumber(group({ status: 'ENDED' }))).toBe(false);
    expect(canAddNumber(group({ wa_mode: 'none' }))).toBe(false);
    expect(canAddNumber(group({ wa_group_id: null }))).toBe(false);
    expect(canAddNumber(group({ channel: null }))).toBe(false);
  });
});

describe('staffNumberNote (219, 299)', () => {
  it('warns on a removal with no saved number, and is quiet on an addition', () => {
    const none = { status: 'none', reason: 'no_saved_number' };
    expect(staffNumberNote(none, 'remove')).toEqual({
      tone: 'warning',
      key: 'numberUnknown',
    });
    expect(staffNumberNote(none, 'give')).toBeNull();
  });

  it.each(['give', 'remove'] as const)('on %s says the rest', (change) => {
    expect(staffNumberNote({ status: 'added' }, change)?.key).toBe(
      'numberAdded'
    );
    expect(staffNumberNote({ status: 'removed' }, change)?.key).toBe(
      'numberRemoved'
    );
    expect(staffNumberNote({ status: 'refused' }, change)?.key).toBe(
      'numberRefused'
    );
    expect(staffNumberNote({ status: 'failed' }, change)?.key).toBe(
      'numberFailed'
    );
    for (const quiet of [
      { status: 'none', reason: 'not_in_group' },
      { status: 'none', reason: 'no_access_row' },
      { status: 'skipped', reason: 'no_whatsapp' },
      { status: 'already' },
      null,
      undefined,
    ]) {
      expect(staffNumberNote(quiet, change)).toBeNull();
    }
  });
});

describe('addNumberFailure', () => {
  it('never words an unknown outcome as a failure', () => {
    const unconfirmed = { error: 'x', code: 'send_unconfirmed' };
    expect(addNumberFailure(502, unconfirmed)).toEqual({ key: 'maybeAdded' });
    expect(addNumberFailure(504, null)).toEqual({ key: 'maybeAdded' });
    expect(addNumberFailure(413, null)).toEqual({ key: 'failed' });
    expect(addNumberFailure(409, { error: 'Ended' })).toEqual({
      words: 'Ended',
    });
  });
});

describe('mergeFirstPage', () => {
  const at = (id: string, day: number) =>
    item({
      id,
      last_activity_at: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`,
    });
  // Two pages loaded (5 rows), the first page being 3 rows.
  const old = {
    groups: [at('a', 20), at('b', 19), at('c', 18), at('d', 17), at('e', 16)],
    next: 'OLD',
  };
  const ids = (r: { groups: SgListItem[] }) => r.groups.map((g) => g.id);

  it('keeps the rows beyond page one and the old cursor', () => {
    const r = mergeFirstPage(
      old,
      { groups: [at('a', 20), at('b', 19), at('c', 18)], next: 'NEW' },
      'active'
    );
    expect(ids(r)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(r.next).toBe('OLD');
  });

  it('puts a new row on top and a moved row where it now sorts', () => {
    const r = mergeFirstPage(
      old,
      { groups: [at('n', 22), at('c', 21), at('a', 20)], next: 'NEW' },
      'active'
    );
    // c moved up; b now sorts past page one's last row and stays.
    expect(ids(r)).toEqual(['n', 'c', 'a', 'b', 'd', 'e']);
  });

  it('drops an old row inside the fresh range that is gone', () => {
    const r = mergeFirstPage(
      old,
      { groups: [at('a', 20), at('c', 18), at('d', 17)], next: 'NEW' },
      'active'
    );
    expect(ids(r)).toEqual(['a', 'c', 'd', 'e']);
  });

  it('replaces when one page was loaded or the fresh page is everything', () => {
    const fresh = { groups: [at('x', 25)], next: 'NEW' };
    expect(
      mergeFirstPage({ groups: [at('a', 20)], next: 'OLD' }, fresh, 'active')
    ).toEqual(fresh);
    const all = { groups: [at('x', 25)], next: null };
    expect(mergeFirstPage(old, all, 'active')).toEqual(all);
  });
});
