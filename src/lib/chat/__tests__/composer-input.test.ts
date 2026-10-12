import { describe, expect, it } from 'vitest';

import { serializeDraft, type MentionCandidate } from '../composer';
import {
  applyPinEvents,
  chipInputs,
  chipsReady,
  composerKeyAction,
  editSubmission,
  EMPTY_DRAFT,
  helperLine,
  offersBroadcasts,
  pickCandidate,
  settleChip,
  uploadingChip,
  withMark,
  wrapIndex,
} from '../composer-input';
import type { ChatPerson } from '../types';

const SARA = '11111111-1111-4111-8111-111111111111';
const SARA2 = '22222222-2222-4222-8222-222222222222';
const CH = 'c0000000-0000-4000-8000-000000000001';
const OTHER = 'c0000000-0000-4000-8000-000000000002';

const person = (userId: string, fullName: string): ChatPerson => ({
  userId,
  fullName,
  avatarUrl: null,
  role: 'agent',
  bankCode: null,
  presenceStatus: null,
  lastSeenAt: null,
});
const pick = (p: ChatPerson): MentionCandidate => ({
  type: 'person',
  person: p,
  name: p.fullName ?? '',
});
const key = (k: string, o: { shiftKey?: boolean; composing?: boolean } = {}) =>
  ({ key: k, shiftKey: !!o.shiftKey, composing: !!o.composing }) as const;

describe('composerKeyAction', () => {
  it('Enter sends, Shift+Enter is a newline, Esc cancels', () => {
    expect(composerKeyAction(key('Enter'), false)).toBe('send');
    expect(composerKeyAction(key('Enter', { shiftKey: true }), false)).toBe(
      null
    );
    expect(composerKeyAction(key('Escape'), false)).toBe('cancel');
    expect(composerKeyAction(key('a'), false)).toBe(null);
  });

  it('never acts while an IME composition is active', () => {
    for (const k of ['Enter', 'Escape', 'ArrowDown', 'Tab'])
      for (const popover of [false, true])
        expect(composerKeyAction(key(k, { composing: true }), popover)).toBe(
          null
        );
  });

  it('drives the open mention list', () => {
    expect(composerKeyAction(key('ArrowDown'), true)).toBe('next');
    expect(composerKeyAction(key('ArrowUp'), true)).toBe('prev');
    expect(composerKeyAction(key('Enter'), true)).toBe('pick');
    expect(composerKeyAction(key('Tab'), true)).toBe('pick');
    expect(composerKeyAction(key('Escape'), true)).toBe('close');
    expect(composerKeyAction(key('Tab'), false)).toBe(null);
    expect(composerKeyAction(key('ArrowDown'), false)).toBe(null);
  });
});

describe('wrapIndex', () => {
  it('wraps both ways and is 0 for an empty list', () => {
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(1, 3)).toBe(1);
    expect(wrapIndex(5, 0)).toBe(0);
  });
});

describe('pickCandidate', () => {
  it('replaces the query with a readable label that serializes to a token', () => {
    const r = pickCandidate(
      { text: 'hi @sa', picked: [] },
      6,
      pick(person(SARA, 'Sara Ahmed'))
    );
    expect(r.draft.text).toBe('hi @Sara Ahmed ');
    expect(r.caret).toBe(r.draft.text.length);
    expect(serializeDraft(r.draft.text, r.draft.picked)).toBe(`hi <@${SARA}> `);
  });

  it('numbers a second person with the same name', () => {
    const first = pickCandidate(EMPTY_DRAFT, 0, pick(person(SARA, 'Sara')));
    const typed = { ...first.draft, text: `${first.draft.text}@s` };
    const r = pickCandidate(
      typed,
      typed.text.length,
      pick(person(SARA2, 'Sara'))
    );
    expect(r.draft.text).toBe('@Sara @Sara (2) ');
    expect(serializeDraft(r.draft.text, r.draft.picked)).toBe(
      `<@${SARA}> <@${SARA2}> `
    );
  });

  it('inserts @channel / @here as text, with no pick', () => {
    const r = pickCandidate({ text: '@ch', picked: [] }, 3, {
      type: 'broadcast',
      kind: 'channel',
    });
    expect(r.draft).toEqual({ text: '@channel ', picked: [] });
  });
});

describe('helperLine / offersBroadcasts', () => {
  it('names the place being written to', () => {
    expect(helperLine('team', 'sales', false)).toEqual({
      key: 'helperChannel',
      name: 'sales',
    });
    expect(helperLine('private', 'ops', false).key).toBe('helperChannel');
    expect(helperLine('dm', 'Sara, Omar', false)).toEqual({
      key: 'helperDm',
      names: 'Sara, Omar',
    });
    expect(helperLine('deal_room', 'X', false)).toEqual({ key: 'helperNotes' });
    expect(helperLine('team', 'sales', true)).toEqual({ key: 'helperThread' });
  });

  it('offers @channel / @here in team and private channels only', () => {
    expect(offersBroadcasts('team')).toBe(true);
    expect(offersBroadcasts('private')).toBe(true);
    expect(offersBroadcasts('dm')).toBe(false);
    expect(offersBroadcasts('deal_room')).toBe(false);
  });
});

describe('file chips', () => {
  const input = { storage_path: 'p', name: 'a.pdf', mime: 'x', bytes: 1 };

  it('send waits for uploads and refuses a failed chip', () => {
    const chips = [uploadingChip('1', 'a.pdf'), uploadingChip('2', 'b.pdf')];
    expect(chipsReady(chips)).toBe(false);
    const one = settleChip(chips, '1', { input });
    expect(chipsReady(one)).toBe(false);
    const failed = settleChip(one, '2', { error: 'uploadFailed' });
    expect(failed[1]).toMatchObject({
      status: 'failed',
      error: 'uploadFailed',
    });
    expect(chipsReady(failed)).toBe(false);
    expect(chipsReady(failed.slice(0, 1))).toBe(true);
    expect(chipInputs(failed)).toEqual([input]);
    expect(chipsReady([])).toBe(true);
  });

  it('a chip removed while uploading stays removed', () => {
    expect(settleChip([], '1', { input })).toEqual([]);
  });
});

describe('editSubmission', () => {
  const people = {
    text: `hello @Sara`,
    picked: [{ userId: SARA, label: 'Sara' }],
  };

  it('saves the serialized body, and skips an unchanged one', () => {
    expect(editSubmission('hello', people, [])).toEqual({
      kind: 'save',
      body: `hello <@${SARA}>`,
    });
    expect(editSubmission(`hello <@${SARA}>`, people, [])).toEqual({
      kind: 'unchanged',
    });
  });

  it('refuses blank and over-long text; files keep a cleared body valid', () => {
    expect(editSubmission('x', { text: '  ', picked: [] }, [])).toEqual({
      kind: 'invalid',
      reason: 'empty',
    });
    expect(
      editSubmission('x', { text: 'y'.repeat(8001), picked: [] }, [])
    ).toEqual({ kind: 'invalid', reason: 'bodyLength' });
    expect(editSubmission('x', EMPTY_DRAFT, ['a.pdf'])).toEqual({
      kind: 'save',
      body: 'a.pdf',
    });
  });
});

describe('pin marks', () => {
  it('withMark adds and removes without touching the input', () => {
    const a = new Set(['m1']);
    expect([...withMark(a, 'm2', true)]).toEqual(['m1', 'm2']);
    expect([...withMark(a, 'm1', false)]).toEqual([]);
    expect([...a]).toEqual(['m1']);
  });

  it('replays this channel’s events in order and ignores other channels', () => {
    const read = new Set(['m1']);
    const next = applyPinEvents(read, CH, [
      { type: 'unpin', channelId: CH, messageId: 'm1' },
      { type: 'pin', channelId: CH.toUpperCase(), messageId: 'm2' },
      { type: 'pin', channelId: OTHER, messageId: 'm3' },
      { type: 'pin', channelId: CH, messageId: 'm1' },
      { type: 'unpin', channelId: CH, messageId: 'm2' },
    ]);
    expect([...next].sort()).toEqual(['m1']);
    expect([...applyPinEvents(read, CH, [])]).toEqual(['m1']);
  });
});
