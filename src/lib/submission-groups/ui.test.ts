import { describe, expect, it } from 'vitest';

import { caseStatusView } from '@/lib/cases/ui';

import {
  AVATAR_TONES,
  avatarTone,
  groupContactName,
  groupTitle,
  initialsOf,
  onlyMine,
  shortRef,
  trackerStatusChip,
  waIdPhone,
  inviteNotice,
  coordinatorPhonesOf,
  addableStaff,
  appendPage,
  bubbleKind,
  canRetryCreate,
  endReasonView,
  groupBanners,
  listUrl,
  parseSgList,
  waModeOf,
  sendErrorKey,
  sendStatusOf,
  sentAsPreview,
  staffSenderLine,
  type SgGroup,
  type SgListItem,
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
    expect(listUrl('ended', ' SUB 1 ', 'c2', 10)).toBe(
      '/api/submission-groups?status=ended&limit=10&q=SUB+1&cursor=c2'
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

describe('sendErrorKey', () => {
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

describe('group display (141)', () => {
  const contact = (name: string | null, phone: string | null = '9715') => ({
    id: 'c1',
    name,
    phone,
  });

  it('titles a group by the company, then the contact name, then the phone', () => {
    expect(
      groupTitle({ customer_name: 'Acme LLC', contact: contact('Nasrullah') })
    ).toBe('Acme LLC');
    expect(
      groupTitle({ customer_name: '  ', contact: contact('Nasrullah') })
    ).toBe('Nasrullah');
    expect(groupTitle({ contact: contact(null, '97150') })).toBe('97150');
    expect(groupTitle({ customer_name: null, contact: null })).toBeNull();
  });

  it('names the contact person only when it differs from the title', () => {
    expect(
      groupContactName({
        customer_name: 'Acme LLC',
        contact: contact('Nasrullah'),
      })
    ).toBe('Nasrullah');
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
});
