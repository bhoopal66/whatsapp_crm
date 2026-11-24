import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  leaveSession,
  resetSessionCacheForTests,
  sessionCache,
  sessionKey,
} from '@/lib/session-cache';
import {
  NEW_NOTE,
  closeDecision,
  isUnsaved,
  keepMine,
  keepTheirs,
  onNotes,
  onOutcome,
  onRow,
  onSaved,
  onSend,
  saveBody,
  type NoteAnswer,
  type NoteBody,
  type NoteDraft,
} from './call-note';
import {
  NOTE_SAVE_DELAY_MS,
  createCallNote,
  dropKeptCallNote,
  keepCallNote,
  keptCallNote,
  sendCallNote,
} from './call-note-store';

const row = (
  notes: string | null = null,
  disposition: NoteDraft['outcome'] = null
) => ({ notes, disposition });
const typed = (text: string, stored: string | null = null) =>
  onNotes(onRow(NEW_NOTE, row(stored)), text);
/** One save of everything there is, answered `answer`. */
const save = (d: NoteDraft, answer: NoteAnswer | null) => {
  const body = saveBody(d)!;
  return onSaved(onSend(d, body), body, answer);
};
const ok = (notes: string | null): NoteAnswer => ({ status: 200, notes });
const conflict = (notes: string | null): NoteAnswer => ({
  status: 409,
  conflict: true,
  notes,
});

describe('onRow', () => {
  it('fills an untouched panel, once', () => {
    const d = onRow(NEW_NOTE, row(' theirs ', 'interested'));
    expect(d).toMatchObject({
      notes: ' theirs ',
      seen: 'theirs',
      outcome: 'interested',
    });
    expect(isUnsaved(d)).toBe(false);
    expect(onRow(d, row('newer', null))).toBe(d);
  });

  it('keeps text typed before it, as written over an empty note', () => {
    let d = onRow(onNotes(NEW_NOTE, 'mine'), row('theirs', 'call_back'));
    expect(d).toMatchObject({ notes: 'mine', seen: null });
    // What was not touched is filled all the same.
    expect(d.outcome).toBe('call_back');
    // Nor does a poll after it take the stored text as seen.
    d = onRow(d, row('theirs'));
    expect(saveBody(d)).toEqual({ notes: 'mine', notesSeen: null });
    d = save(d, conflict('theirs')).draft;
    expect(d.conflict).toEqual({ theirs: 'theirs' });
    expect(d.notes).toBe('mine');
  });

  it('keeps an outcome chosen before it, and fills a note typed away', () => {
    const d = onRow(
      onNotes(onNotes(onOutcome(NEW_NOTE, 'interested'), 'x'), ''),
      row('theirs', 'call_back')
    );
    expect(d).toMatchObject({ outcome: 'interested', notes: 'theirs' });
    expect(saveBody(d)).toEqual({ disposition: 'interested' });
  });
});

describe('saving', () => {
  it('sends only what changed, with the text it was written over', () => {
    expect(saveBody(typed('one', 'one '))).toBeNull();
    expect(saveBody(typed('two', 'one'))).toEqual({
      notes: 'two',
      notesSeen: 'one',
    });
    expect(saveBody(onOutcome(NEW_NOTE, null))).toEqual({ disposition: null });
  });

  it('is clean once the sent text is stored, not the one typed since', () => {
    const d = typed('two ', 'one');
    const body = saveBody(d)!;
    const { draft } = onSaved(
      onNotes(onSend(d, body), 'two!'),
      body,
      ok('two')
    );
    expect(draft).toMatchObject({ seen: 'two', notesDirty: true, sent: [] });
    expect(isUnsaved(save(d, ok('two')).draft)).toBe(false);
  });

  it('keeps an outcome changed while the last one was on its way', () => {
    const d = onOutcome(NEW_NOTE, 'interested');
    const body = saveBody(d)!;
    const { draft } = onSaved(onOutcome(onSend(d, body), null), body, ok(null));
    expect(saveBody(draft)).toEqual({ disposition: null });
  });

  it('a text taken back while on its way is still sent', () => {
    const d = typed('a');
    expect(saveBody(onNotes(onSend(d, saveBody(d)!), ''))).toEqual({
      notes: '',
      notesSeen: null,
    });
  });

  it.each([null, { status: 500 }])('is unsaved when lost (%o)', (answer) => {
    const { draft, retry } = save(typed('a'), answer);
    expect(draft).toMatchObject({ failed: 'lost', saving: false, sent: ['a'] });
    expect([isUnsaved(draft), retry]).toEqual([true, false]);
  });

  it.each([403, 404, 409, 400])('is unsaved when refused (%i)', (status) => {
    const { draft, retry } = save(typed('a'), { status });
    expect(draft).toMatchObject({
      failed: 'refused',
      conflict: null,
      sent: [],
    });
    expect([isUnsaved(draft), retry]).toEqual([true, false]);
  });
});

describe('a conflict', () => {
  it('with our own lost save is taken as seen and sent again, once', () => {
    let d = onNotes(save(typed('a'), null).draft, 'ab');
    const first = save(d, conflict('a'));
    expect(first).toMatchObject({ retry: true });
    d = first.draft;
    expect(d.conflict).toBeNull();
    expect(saveBody(d)).toEqual({ notes: 'ab', notesSeen: 'a' });
    const second = save(d, conflict('a'));
    expect(second.retry).toBe(false);
    expect(second.draft.conflict).toEqual({ theirs: 'a' });
  });

  it('with the same text is no conflict', () => {
    const { draft } = save(typed('same '), conflict('same'));
    expect([draft.conflict, isUnsaved(draft)]).toEqual([null, false]);
  });

  it('holds the note back and lets the outcome go alone', () => {
    const d = onOutcome(typed('mine', 'one'), 'interested');
    const { draft, retry } = save(d, conflict('theirs'));
    expect(retry).toBe(true);
    expect(saveBody(draft)).toEqual({ disposition: 'interested' });
    const after = save(draft, ok('theirs')).draft;
    expect(after.conflict).toEqual({ theirs: 'theirs' });
    expect(saveBody(after)).toBeNull();
    expect(isUnsaved(after)).toBe(true);
  });

  it('is settled by either text', () => {
    const d = save(typed('mine', 'one'), conflict('theirs')).draft;
    expect(saveBody(keepMine(d))).toEqual({
      notes: 'mine',
      notesSeen: 'theirs',
    });
    const theirs = keepTheirs(d);
    expect(theirs).toMatchObject({ notes: 'theirs', conflict: null });
    expect(isUnsaved(theirs)).toBe(false);
    expect(
      keepTheirs(save(typed('mine', 'one'), conflict(null)).draft).notes
    ).toBe('');
  });
});

describe('closeDecision', () => {
  it('closes only what is saved', () => {
    const lost = save(typed('a'), null).draft;
    const held = save(typed('a', 'b'), conflict('c')).draft;
    expect(closeDecision(NEW_NOTE, false)).toBe('close');
    expect(closeDecision(save(typed('a'), ok('a')).draft, true)).toBe('close');
    for (const d of [lost, held, onNotes(NEW_NOTE, 'before the row')]) {
      expect(closeDecision(d, false)).toBe('stay');
      expect(closeDecision(d, true)).toBe('keep');
    }
  });
});

describe('createCallNote', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  const setup = (...answers: (NoteAnswer | null)[]) => {
    const send = vi.fn<(id: string, b: NoteBody) => Promise<NoteAnswer | null>>(
      async () => (answers.length ? answers.shift()! : null)
    );
    return { send, note: createCallNote(NEW_NOTE, send) };
  };

  it('queues what is typed before the row and saves it when it comes', async () => {
    const { send, note } = setup(ok('early'));
    note.edit((d) => onNotes(d, 'early'));
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DELAY_MS);
    await note.save();
    expect(send).not.toHaveBeenCalled();
    expect(closeDecision(note.get(), false)).toBe('stay');
    note.row('c1', row());
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls).toEqual([
      ['c1', { notes: 'early', notesSeen: null }],
    ]);
    expect(closeDecision(note.get(), false)).toBe('close');
  });

  it('waits out the typing, then sends once', async () => {
    const { send, note } = setup(ok('ab'));
    note.row('c1', row());
    note.edit((d) => onNotes(d, 'a'));
    note.edit((d) => onNotes(d, 'ab'));
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DELAY_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps what is typed while an answer is out', async () => {
    const { send, note } = setup(ok('a'), ok('ab'));
    note.row('c1', row());
    note.edit((d) => onNotes(d, 'a'));
    const first = note.save();
    await Promise.resolve();
    note.edit((d) => onNotes(d, 'ab'));
    await first;
    expect(note.get()).toMatchObject({ notes: 'ab', notesDirty: true });
    await note.save();
    expect(send.mock.lastCall![1]).toEqual({ notes: 'ab', notesSeen: 'a' });
  });

  it('recovers from a lost answer by itself', async () => {
    const { send, note } = setup(null, conflict('a'), ok('ab'));
    note.row('c1', row());
    note.edit((d) => onNotes(d, 'a'));
    await note.save();
    note.edit((d) => onNotes(d, 'ab'));
    await note.save();
    expect(send).toHaveBeenCalledTimes(3);
    expect(closeDecision(note.get(), false)).toBe('close');
  });
});

describe('sendCallNote', () => {
  afterEach(() => void vi.unstubAllGlobals());

  it('reads a page that is not JSON, or no answer, as none', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>', { status: 200 }));
    expect(await sendCallNote('c1', {})).toBeNull();
    vi.stubGlobal('fetch', async () => Promise.reject(new Error('offline')));
    expect(await sendCallNote('c1', {})).toBeNull();
    vi.stubGlobal('fetch', async () =>
      Response.json(
        { error: 'x', conflict: true, notes: 'theirs' },
        { status: 409 }
      )
    );
    expect(await sendCallNote('c1', {})).toEqual(conflict('theirs'));
  });
});

describe('keepCallNote', () => {
  const key = sessionKey('acct', 'user', 'call-note:pbx:1')!;
  const show = vi.fn();
  const hide = vi.fn();
  beforeEach(() => {
    resetSessionCacheForTests();
    vi.clearAllMocks();
  });
  const leaving = (answer: NoteAnswer | null) => {
    let reply!: (a: NoteAnswer | null) => void;
    const note = createCallNote(
      NEW_NOTE,
      () => new Promise((r) => (reply = r))
    );
    note.row('c1', row());
    note.edit((d) => onNotes(d, 'mine'));
    const kept = keepCallNote(key, note, { tried: false, show, hide });
    return { kept, answer: () => reply(answer) };
  };

  it('keeps nothing that is saved', async () => {
    const note = createCallNote(NEW_NOTE);
    await keepCallNote(key, note, { tried: true, show, hide });
    expect(keptCallNote(key)).toBeNull();
    expect(show).not.toHaveBeenCalled();
  });

  it('keeps first, saves once more, and tells only if that fails', async () => {
    const lost = leaving(null);
    expect(keptCallNote(key)).toMatchObject({ notes: 'mine', saving: false });
    await Promise.resolve();
    lost.answer();
    await lost.kept;
    expect(show).toHaveBeenCalledTimes(1);
    expect(keptCallNote(key)).toMatchObject({ notes: 'mine', failed: 'lost' });
    // Taken back by a panel: the message goes.
    dropKeptCallNote(key);
    expect(hide).toHaveBeenCalledTimes(1);

    const saved = leaving(ok('mine'));
    await Promise.resolve();
    saved.answer();
    await saved.kept;
    expect(show).toHaveBeenCalledTimes(1);
    expect(keptCallNote(key)).toBeNull();
  });

  it('leaves alone a draft taken back meanwhile, which knows the text', async () => {
    const l = leaving(null);
    const taken = keptCallNote(key)!;
    dropKeptCallNote(key);
    expect(save(onNotes(taken, 'mine, more'), conflict('mine')).retry).toBe(
      true
    );
    await Promise.resolve();
    l.answer();
    await l.kept;
    expect(keptCallNote(key)).toBeNull();
    expect(show).not.toHaveBeenCalled();
  });

  it('tells at once when the save was just tried', async () => {
    const note = createCallNote(save(typed('mine'), null).draft);
    await keepCallNote(key, note, { tried: true, show, hide });
    expect(show).toHaveBeenCalledTimes(1);
    // A sign-out takes both the draft and the message.
    sessionCache.clear();
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('puts nothing back after a sign-out, and drops nothing that is not there', async () => {
    const wipes = sessionCache.wipeCount();
    dropKeptCallNote(key);
    expect(sessionCache.wipeCount()).toBe(wipes);
    leaveSession();
    const note = createCallNote(typed('mine'));
    await keepCallNote(key, note, { tried: true, show, hide });
    expect(keptCallNote(key)).toBeNull();
    expect(show).not.toHaveBeenCalled();
  });
});
