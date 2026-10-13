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
  attachments: [],
  reactions: [],
  thread: null,
  ...o,
});
const who = {
  userId: ME,
  workspaceAdmin: false,
  canWrite: true,
  threads: true,
};

describe('messageActions', () => {
  it('gives the author everything', () => {
    expect(messageActions(msg(), who)).toEqual({
      react: true,
      thread: true,
      edit: true,
      delete: true,
      pin: true,
      save: true,
      copy: true,
    });
  });
  it('edit is the author’s, delete the author’s or an admin’s', () => {
    const theirs = msg({ authorId: YOU });
    expect(messageActions(theirs, who)).toMatchObject({
      edit: false,
      delete: false,
    });
    expect(
      messageActions(theirs, { ...who, workspaceAdmin: true })
    ).toMatchObject({ edit: false, delete: true });
  });
  it('replies have no thread; write actions need write access', () => {
    expect(messageActions(msg({ threadRootId: 'r' }), who).thread).toBe(false);
    expect(messageActions(msg(), { ...who, threads: false }).thread).toBe(
      false
    );
    expect(messageActions(msg(), { ...who, canWrite: false })).toMatchObject({
      react: false,
      edit: false,
      pin: false,
      delete: true,
      save: true,
    });
  });
  it('system posts only react; tombstones nothing', () => {
    const sys = messageActions(msg({ authorKind: 'system', authorId: null }), {
      ...who,
      workspaceAdmin: true,
    });
    expect(Object.entries(sys).filter(([, v]) => v)).toEqual([['react', true]]);
    for (const m of [msg({ deletedAt: 'x' }), msg({ erasedAt: 'x' })])
      expect(Object.values(messageActions(m, who)).some(Boolean)).toBe(false);
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
