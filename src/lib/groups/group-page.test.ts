import { describe, expect, it } from 'vitest';

import {
  groupMessagesByDay,
  inviteMessagePreview,
  mergeMessages,
  parseBlocks,
  reasonKey,
  removalFailed,
  resolveTab,
  shouldSendOnKey,
  statusTick,
  summarizeAddMembers,
  summarizeInviteSend,
  visibleTabs,
} from './group-page';

describe('reasonKey', () => {
  it('keeps known codes and folds the rest into unknown', () => {
    expect(reasonKey('not_group_admin')).toBe('not_group_admin');
    expect(reasonKey('channel_disconnected')).toBe('channel_disconnected');
    expect(reasonKey('own_number')).toBe('own_number');
    expect(reasonKey('something_new')).toBe('unknown');
    expect(reasonKey(42)).toBe('unknown');
    expect(reasonKey(undefined)).toBe('unknown');
  });
});

describe('parseBlocks', () => {
  it('keeps null as allowed and blocks anything the server left out', () => {
    const b = parseBlocks({
      send: null,
      members: 'not_group_admin',
      leave: 'x',
    });
    expect(b.send).toBeNull();
    expect(b.members).toBe('not_group_admin');
    expect(b.leave).toBe('unknown');
    expect(b.invite).toBe('unknown');
  });
  it('blocks everything on a malformed body', () => {
    expect(Object.values(parseBlocks(null)).every((v) => v === 'unknown')).toBe(
      true
    );
  });
});

describe('visibleTabs', () => {
  const base = { settings: {}, pendingRequests: 0, canEditManagers: false };
  it('hides requests and managers by default', () => {
    expect(visibleTabs(base)).toEqual([
      'chat',
      'members',
      'settings',
      'invite',
    ]);
  });
  it('shows requests while approval is on or someone is waiting', () => {
    expect(
      visibleTabs({ ...base, settings: { approve_participants: 'admins' } })
    ).toContain('requests');
    expect(visibleTabs({ ...base, pendingRequests: 2 })).toContain('requests');
    expect(
      visibleTabs({ ...base, settings: { approve_participants: 'anyone' } })
    ).not.toContain('requests');
  });
  it('shows managers to who may edit them', () => {
    expect(visibleTabs({ ...base, canEditManagers: true }).at(-1)).toBe(
      'managers'
    );
  });
});

describe('groupMessagesByDay', () => {
  const m = (id: string, created_at: string) => ({ id, created_at });
  it('splits on the calendar day of the given time zone', () => {
    const days = groupMessagesByDay(
      [
        m('a', '2026-10-15T19:30:00Z'), // 23:30 Dubai, 15th
        m('b', '2026-10-15T20:30:00Z'), // 00:30 Dubai, 16th
        m('c', '2026-10-16T08:00:00Z'),
      ],
      'Asia/Dubai'
    );
    expect(days.map((d) => [d.day, d.messages.map((x) => x.id)])).toEqual([
      ['2026-10-15', ['a']],
      ['2026-10-16', ['b', 'c']],
    ]);
  });
  it('is empty for no messages', () => {
    expect(groupMessagesByDay([], 'UTC')).toEqual([]);
  });
});

describe('mergeMessages', () => {
  it('dedupes by id, newer copy wins, sorted oldest first', () => {
    const out = mergeMessages(
      [
        { id: 'b', created_at: '2026-10-16T10:00:00Z', status: 'sent' },
        { id: 'c', created_at: '2026-10-16T11:00:00Z', status: 'sent' },
      ],
      [
        { id: 'b', created_at: '2026-10-16T10:00:00Z', status: 'read' },
        { id: 'a', created_at: '2026-10-16T09:00:00Z', status: 'sent' },
      ]
    );
    expect(out.map((x) => `${x.id}:${x.status}`)).toEqual([
      'a:sent',
      'b:read',
      'c:sent',
    ]);
  });
});

describe('statusTick', () => {
  it('maps outgoing statuses and leaves incoming bare', () => {
    expect(statusTick('out', null)).toBe('clock');
    expect(statusTick('out', 'pending')).toBe('clock');
    expect(statusTick('out', 'sent')).toBe('single');
    expect(statusTick('out', 'delivered')).toBe('double');
    expect(statusTick('out', 'read')).toBe('read');
    expect(statusTick('out', 'failed')).toBe('failed');
    expect(statusTick('in', 'read')).toBeNull();
  });
});

describe('shouldSendOnKey', () => {
  it('sends on Enter only', () => {
    expect(shouldSendOnKey({ key: 'Enter', shiftKey: false })).toBe(true);
    expect(shouldSendOnKey({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(
      shouldSendOnKey({ key: 'Enter', shiftKey: false, isComposing: true })
    ).toBe(false);
    expect(shouldSendOnKey({ key: 'a', shiftKey: false })).toBe(false);
  });
});

describe('summarizeAddMembers', () => {
  it('folds refused and not attempted into one invite list', () => {
    expect(
      summarizeAddMembers({
        added: ['1'],
        refused: ['2', '3'],
        notAttempted: ['3', '4'],
        invalid: ['x'],
        skipped: [{ waId: '5', contactId: 'c', reason: 'opted_out' }, null],
        error: 'rate_limited',
      })
    ).toEqual({
      added: ['1'],
      needInvite: ['2', '3', '4'],
      invalid: ['x'],
      skipped: ['5'],
      error: 'rate_limited',
    });
  });
  it('reads the identity objects the participants route returns', () => {
    // The shape of `addParticipants`' outcome, as the route serialises it.
    const body = {
      added: [{ jid: '971501111111@s.whatsapp.net', waId: '971501111111' }],
      refused: [{ jid: '971502222222@s.whatsapp.net', waId: null }],
      notAttempted: ['971503333333'],
      invalid: [],
      skipped: [{ waId: '971504444444', contactId: 'c', reason: 'opted_out' }],
      error: null,
    };
    expect(summarizeAddMembers(body)).toEqual({
      added: ['971501111111'],
      needInvite: ['971502222222', '971503333333'],
      invalid: [],
      skipped: ['971504444444'],
      error: null,
    });
  });
  it('tolerates an empty body', () => {
    expect(summarizeAddMembers(null)).toEqual({
      added: [],
      needInvite: [],
      invalid: [],
      skipped: [],
      error: null,
    });
  });
});

describe('summarizeInviteSend', () => {
  it('counts rows by status and drops malformed ones', () => {
    const s = summarizeInviteSend({
      results: [
        { waId: '1', contactId: 'c1', status: 'sent', reason: null },
        { waId: '2', contactId: null, status: 'failed', reason: 'billing' },
        { waId: '3', contactId: null, status: 'skipped', reason: 'opted_out' },
        { waId: '4', status: 'not_attempted', reason: 'over_limit' },
        { waId: '5', status: 'weird' },
        { status: 'sent' },
      ],
    });
    expect(s).toMatchObject({
      sent: 1,
      failed: 2,
      skipped: 1,
      notAttempted: 1,
      invalid: 0,
    });
    expect(s.rows).toHaveLength(5);
    expect(s.rows[3]).toEqual({
      waId: '4',
      contactId: null,
      status: 'not_attempted',
      reason: 'over_limit',
    });
  });
});

describe('inviteMessagePreview', () => {
  it('replaces %URL% or appends the link like the server', () => {
    expect(inviteMessagePreview('Join: %URL%', 'L')).toBe('Join: L');
    expect(inviteMessagePreview('Join us', 'L')).toBe('Join us\nL');
    expect(inviteMessagePreview('  ', 'L')).toBe('L');
  });
});

describe('resolveTab', () => {
  const visible = ['chat', 'members', 'settings', 'invite'] as const;
  it('follows ?tab= and falls back to chat', () => {
    expect(resolveTab('invite', visible)).toBe('invite');
    expect(resolveTab(undefined, visible)).toBe('chat');
    expect(resolveTab(null, visible)).toBe('chat');
    expect(resolveTab('nope', visible)).toBe('chat');
  });
  it('reads a tab the person does not see as chat', () => {
    expect(resolveTab('requests', visible)).toBe('chat');
    expect(resolveTab('requests', [...visible, 'requests'])).toBe('requests');
  });
});

describe('removalFailed', () => {
  it('is true only when WhatsApp refused someone', () => {
    expect(removalFailed({ removed: 1, failed: [] })).toBe(false);
    expect(removalFailed({ removed: 0, failed: ['9715'] })).toBe(true);
    expect(removalFailed({ failed: [{ waId: '9715' }] })).toBe(true);
    expect(removalFailed(null)).toBe(false);
  });
});

describe('reason codes', () => {
  it('knows the create-group outcomes', () => {
    expect(reasonKey('no_participants')).toBe('no_participants');
    expect(reasonKey('saved_failed_run_sync')).toBe('saved_failed_run_sync');
  });
});
