import { describe, expect, it } from 'vitest';

import { formatMention } from '../mentions';
import {
  applyLocalPatch,
  canViewEditHistory,
  editHistoryRows,
  localPatch,
  messageActions,
  plainText,
} from '../message-actions';
import { ALL_ALLOWED, type ChatCapability } from '../permissions';
import type { ChatMessage } from '../types';

const ME = '11111111-1111-4111-8111-111111111111';
const YOU = '22222222-2222-4222-8222-222222222222';
const msg = (o: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  channelId: 'c1',
  accountId: 'a1',
  threadRootId: null,
  authorKind: 'user',
  authorId: ME,
  body: 'hello',
  meta: {},
  createdAt: '2026-10-12T09:00:00Z',
  editedAt: null,
  deletedAt: null,
  erasedAt: null,
  deletedBy: null,
  replyToId: null,
  forwarded: null,
  attachments: [],
  reactions: [],
  thread: null,
  ...o,
});
const POSTED = Date.parse('2026-10-12T09:00:00Z');
const who = {
  userId: ME,
  workspaceAdmin: false,
  canWrite: true,
  threads: true,
  permissions: ALL_ALLOWED,
  now: POSTED + 60_000,
};
const denied = (...caps: ChatCapability[]) => ({
  ...ALL_ALLOWED,
  can: {
    ...ALL_ALLOWED.can,
    ...Object.fromEntries(caps.map((c) => [c, false])),
  },
});
const windows = (edit: number | null, del: number | null, apply = true) => ({
  ...ALL_ALLOWED,
  editWindowMinutes: edit,
  deleteWindowMinutes: del,
  windowsApply: apply,
});

describe('messageActions', () => {
  it('gives the author everything', () => {
    expect(messageActions(msg(), who)).toEqual({
      react: true,
      quote: true,
      thread: true,
      edit: true,
      delete: true,
      moderate: false,
      pin: true,
      save: true,
      copy: true,
      forward: true,
    });
  });
  it('edit and delete are the author’s; removing another’s is moderation', () => {
    const theirs = msg({ authorId: YOU });
    expect(messageActions(theirs, who)).toMatchObject({
      edit: false,
      delete: false,
      moderate: false,
    });
    expect(
      messageActions(theirs, { ...who, workspaceAdmin: true })
    ).toMatchObject({ edit: false, delete: false, moderate: true });
    expect(
      messageActions(theirs, { ...who, channelAdmin: true })
    ).toMatchObject({ edit: false, delete: false, moderate: true });
    // One's own post stays a plain delete, even for an admin.
    expect(
      messageActions(msg(), {
        ...who,
        workspaceAdmin: true,
        channelAdmin: true,
      })
    ).toMatchObject({ delete: true, moderate: false });
  });
  it('replies have no thread; write actions need write access', () => {
    expect(messageActions(msg({ threadRootId: 'r' }), who).thread).toBe(false);
    expect(messageActions(msg(), { ...who, threads: false }).thread).toBe(
      false
    );
    expect(messageActions(msg(), { ...who, canWrite: false })).toMatchObject({
      react: false,
      quote: false,
      edit: false,
      pin: false,
      delete: true,
      save: true,
      forward: true,
    });
  });
  it('system posts only react, quote, forward and (admins) remove; tombstones nothing', () => {
    const system = msg({ authorKind: 'system', authorId: null });
    const sys = messageActions(system, { ...who, workspaceAdmin: true });
    expect(Object.entries(sys).filter(([, v]) => v)).toEqual([
      ['react', true],
      ['quote', true],
      ['moderate', true],
      ['forward', true],
    ]);
    // A channel admin may not remove a system post.
    expect(
      messageActions(system, { ...who, channelAdmin: true }).moderate
    ).toBe(false);
    expect(
      messageActions(msg({ authorKind: 'system', authorId: null }), {
        ...who,
        canWrite: false,
      }).quote
    ).toBe(false);
    for (const m of [msg({ deletedAt: 'x' }), msg({ erasedAt: 'x' })])
      expect(Object.values(messageActions(m, who)).some(Boolean)).toBe(false);
  });
});

describe('messageActions and chat permissions (157)', () => {
  it('pin and unpin need pin_messages', () => {
    expect(
      messageActions(msg(), { ...who, permissions: denied('pin_messages') })
    ).toEqual({ ...messageActions(msg(), who), pin: false });
  });
  it('forward needs forward_messages, system posts included', () => {
    const permissions = denied('forward_messages');
    expect(messageActions(msg(), { ...who, permissions })).toEqual({
      ...messageActions(msg(), who),
      forward: false,
    });
    const system = msg({ authorKind: 'system', authorId: null });
    expect(messageActions(system, { ...who, permissions }).forward).toBe(false);
  });
  it('forwarding files also needs upload_files or send_voice; text does not', () => {
    const withFile = msg({ attachments: [{ id: 'f' } as never] });
    const noStorage = denied('upload_files', 'send_voice');
    expect(
      messageActions(withFile, { ...who, permissions: noStorage }).forward
    ).toBe(false);
    expect(
      messageActions(msg(), { ...who, permissions: noStorage }).forward
    ).toBe(true);
    for (const permissions of [denied('upload_files'), denied('send_voice')])
      expect(messageActions(withFile, { ...who, permissions }).forward).toBe(
        true
      );
    const sysFile = msg({
      authorKind: 'system',
      authorId: null,
      attachments: [{ id: 'f' } as never],
    });
    expect(
      messageActions(sysFile, { ...who, permissions: noStorage }).forward
    ).toBe(false);
  });
  it('edit needs edit_own; own delete needs delete_own', () => {
    expect(
      messageActions(msg(), { ...who, permissions: denied('edit_own') })
    ).toEqual({ ...messageActions(msg(), who), edit: false });
    expect(
      messageActions(msg(), { ...who, permissions: denied('delete_own') })
    ).toEqual({ ...messageActions(msg(), who), delete: false });
  });
  it('removing someone else’s message is not affected by delete_own', () => {
    const theirs = msg({ authorId: YOU });
    expect(
      messageActions(theirs, {
        ...who,
        workspaceAdmin: true,
        permissions: denied('delete_own', 'edit_own'),
      })
    ).toMatchObject({ delete: false, moderate: true });
  });
  it('edit and delete close with their windows, the boundary still open', () => {
    const permissions = windows(5, 10);
    const at = (minutes: number) =>
      messageActions(msg(), {
        ...who,
        permissions,
        now: POSTED + minutes * 60_000,
      });
    expect(at(5)).toMatchObject({ edit: true, delete: true });
    expect(at(5.01)).toMatchObject({ edit: false, delete: true });
    expect(at(10)).toMatchObject({ edit: false, delete: true });
    expect(at(10.01)).toMatchObject({ edit: false, delete: false });
    // Everything else stays.
    expect(at(60)).toEqual({
      ...messageActions(msg(), who),
      edit: false,
      delete: false,
    });
  });
  it('the windows bind only when they apply; no window never closes', () => {
    const late = POSTED + 24 * 60 * 60_000;
    expect(
      messageActions(msg(), {
        ...who,
        permissions: windows(5, 5, false),
        now: late,
      })
    ).toMatchObject({ edit: true, delete: true });
    expect(
      messageActions(msg(), {
        ...who,
        permissions: windows(null, null),
        now: late,
      })
    ).toMatchObject({ edit: true, delete: true });
  });
});

describe('copy and local patches', () => {
  it('copies mentions as names', () => {
    const people = [{ userId: YOU, fullName: 'Sara Ahmed' }];
    expect(plainText(`hi <@${YOU}> <@${ME}> @here`, people, 'Unknown')).toBe(
      'hi @Sara Ahmed @Unknown @here'
    );
  });
  it('shows a local change only until the server version moves', () => {
    const m = msg({ attachments: [{ id: 'f' } as never] });
    const del = localPatch(m, { deletedAt: 'now' });
    expect(applyLocalPatch(m, del)).toMatchObject({
      deletedAt: 'now',
      body: '',
      attachments: [],
    });
    const edit = localPatch(m, { body: 'new', editedAt: 'now' });
    expect(applyLocalPatch(m, edit).body).toBe('new');
    const echoed = msg({ body: 'newer', editedAt: 'later' });
    expect(applyLocalPatch(echoed, edit)).toBe(echoed);
    expect(applyLocalPatch(m, null)).toBe(m);
  });
});

describe('edit history', () => {
  const edited = msg({ editedAt: '2026-10-12T09:05:00Z' });
  it('is offered to a workspace owner/admin on an edited post that still stands', () => {
    expect(canViewEditHistory(edited, true)).toBe(true);
    expect(canViewEditHistory(edited, false)).toBe(false);
    expect(canViewEditHistory(msg(), true)).toBe(false);
    for (const gone of [
      { deletedAt: '2026-10-12T10:00:00Z' },
      { erasedAt: '2026-10-12T10:00:00Z' },
      { authorKind: 'system' as const, authorId: null },
    ])
      expect(canViewEditHistory({ ...edited, ...gone }, true)).toBe(false);
  });

  it('lists the earlier bodies newest first, with mentions and editors named', () => {
    const edit = (id: string, at: string, body: string, by = ME) => ({
      id,
      messageId: 'm1',
      previousBody: body,
      editedAt: at,
      editedBy: by,
    });
    const people = [
      { userId: ME, fullName: 'Mia' },
      { userId: YOU, fullName: null },
    ];
    expect(
      editHistoryRows(
        [
          edit('e1', '2026-10-12T09:01:00Z', 'first'),
          edit('e3', '2026-10-12T09:03:00Z', `hi ${formatMention(YOU)}`),
          edit('e2', '2026-10-12T09:03:00Z', 'second', YOU.toUpperCase()),
        ],
        people,
        'Someone'
      )
    ).toEqual([
      {
        id: 'e3',
        body: 'hi @Someone',
        editedAt: '2026-10-12T09:03:00Z',
        editorName: 'Mia',
      },
      {
        id: 'e2',
        body: 'second',
        editedAt: '2026-10-12T09:03:00Z',
        editorName: 'Someone',
      },
      {
        id: 'e1',
        body: 'first',
        editedAt: '2026-10-12T09:01:00Z',
        editorName: 'Mia',
      },
    ]);
  });
});
