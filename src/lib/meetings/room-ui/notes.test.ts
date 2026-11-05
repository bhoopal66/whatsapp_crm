import { describe, expect, it } from 'vitest';

import {
  editedByOther,
  INITIAL_NOTES,
  isDirty,
  notesReducer,
  notesStatus,
  NOTES_MAX_CHARS,
  NOTES_RETRY_DELAY_MS,
  NOTES_SAVE_DELAY_MS,
  parseNotes,
  saveAnswer,
  saveDelay,
  shouldSave,
  type NotesDoc,
  type NotesEvent,
  type NotesState,
} from './notes';

const doc = (body: string, version: number, by = 'aisha'): NotesDoc => ({
  body,
  version,
  updatedBy: by,
  updatedAt: '2026-11-05T10:00:00.000Z',
});
const run = (s: NotesState, ...events: NotesEvent[]) =>
  events.reduce(notesReducer, s);
const loaded = (d: NotesDoc) => run(INITIAL_NOTES, { type: 'polled', doc: d });
const typed = (text: string): NotesEvent => ({ type: 'typed', text });

describe('reading', () => {
  it('takes a newer version while nothing is unsaved', () => {
    const s = run(loaded(doc('one', 1)), {
      type: 'polled',
      doc: doc('two', 2),
    });
    expect(s.text).toBe('two');
    expect(s.base.version).toBe(2);
    expect(s.conflict).toBeNull();
  });

  it('ignores a read of the version it already has, or an older one', () => {
    const s = loaded(doc('one', 3));
    expect(run(s, { type: 'polled', doc: doc('old', 2) })).toBe(s);
    expect(run(s, { type: 'polled', doc: doc('one', 3) })).toBe(s);
  });

  it('ignores a read that lands during its own save', () => {
    const s = run(loaded(doc('one', 1)), typed('mine'), {
      type: 'saveStarted',
    });
    expect(run(s, { type: 'polled', doc: doc('mine', 2, 'me') })).toBe(s);
  });

  it('keeps a restored emptied text, which is an edit too', () => {
    const left = { ...run(loaded(doc('one', 1)), typed('')), loaded: false };
    const s = run(left, { type: 'polled', doc: doc('one', 1) });
    expect(s.text).toBe('');
    expect(shouldSave(s)).toBe(true);
  });

  it('keeps text restored from before the panel closed', () => {
    const left = {
      ...run(loaded(doc('one', 1)), typed('kept')),
      loaded: false,
    };
    const s = run(left, { type: 'polled', doc: doc('one', 1) });
    expect(s.text).toBe('kept');
    expect(s.loaded).toBe(true);
    expect(shouldSave(s)).toBe(true);
  });
});

describe('two people at once', () => {
  it('keeps the text and raises a conflict on a newer read', () => {
    const s = run(loaded(doc('one', 1)), typed('one and mine'), {
      type: 'polled',
      doc: doc('one and theirs', 2),
    });
    expect(s.text).toBe('one and mine');
    expect(s.base.version).toBe(1);
    expect(s.conflict?.body).toBe('one and theirs');
    expect(shouldSave(s)).toBe(false);
  });

  it('keeps the text and raises a conflict on a stale save', () => {
    const s = run(
      loaded(doc('one', 1)),
      typed('mine'),
      { type: 'saveStarted' },
      { type: 'stale', doc: doc('theirs', 2) }
    );
    expect(s.text).toBe('mine');
    expect(s.sending).toBeNull();
    expect(s.conflict?.version).toBe(2);
  });

  it('keeps what was typed while the stale save was in flight', () => {
    const s = run(
      loaded(doc('one', 1)),
      typed('mine'),
      { type: 'saveStarted' },
      typed('mine, more'),
      { type: 'stale', doc: doc('theirs', 2) }
    );
    expect(s.text).toBe('mine, more');
  });

  it('needs no decision when both wrote the same thing', () => {
    const s = run(loaded(doc('one', 1)), typed('same'), {
      type: 'polled',
      doc: doc('same', 2),
    });
    expect(s.conflict).toBeNull();
    expect(isDirty(s)).toBe(false);
    expect(s.base.version).toBe(2);
  });

  it('shows the newest version on a second conflict', () => {
    const s = run(
      loaded(doc('one', 1)),
      typed('mine'),
      { type: 'polled', doc: doc('theirs', 2) },
      { type: 'polled', doc: doc('theirs too', 3) }
    );
    expect(s.conflict?.version).toBe(3);
    expect(s.text).toBe('mine');
  });

  it('See their version replaces the text', () => {
    const s = run(
      loaded(doc('one', 1)),
      typed('mine'),
      { type: 'polled', doc: doc('theirs', 2) },
      { type: 'seeTheirs' }
    );
    expect(s.text).toBe('theirs');
    expect(s.base.version).toBe(2);
    expect(s.conflict).toBeNull();
    expect(isDirty(s)).toBe(false);
  });

  it('Keep mine saves over at the new version', () => {
    const s = run(
      loaded(doc('one', 1)),
      typed('mine'),
      { type: 'polled', doc: doc('theirs', 2) },
      { type: 'keepMine' }
    );
    expect(s.text).toBe('mine');
    expect(s.base.version).toBe(2);
    expect(s.conflict).toBeNull();
    expect(shouldSave(s)).toBe(true);
  });
});

describe('saving', () => {
  const saved = (version: number): NotesEvent => ({
    type: 'saved',
    doc: { version, updatedBy: 'me', updatedAt: 'x' },
  });

  it('is clean after a save of what is on screen', () => {
    const s = run(
      loaded(doc('', 0)),
      typed('a'),
      { type: 'saveStarted' },
      saved(1)
    );
    expect(isDirty(s)).toBe(false);
    expect(notesStatus(s)).toBe('saved');
  });

  it('stays dirty when typing went on during the save', () => {
    const s = run(
      loaded(doc('', 0)),
      typed('a'),
      { type: 'saveStarted' },
      typed('ab'),
      saved(1)
    );
    expect(s.base.body).toBe('a');
    expect(s.base.version).toBe(1);
    expect(shouldSave(s)).toBe(true);
  });

  it('waits for the first read, and for the save in flight', () => {
    expect(shouldSave(run(INITIAL_NOTES, typed('a')))).toBe(false);
    const s = run(loaded(doc('', 0)), typed('a'), { type: 'saveStarted' });
    expect(shouldSave(s)).toBe(false);
    expect(notesStatus(s)).toBe('saving');
  });

  it('retries a failure more slowly and says so', () => {
    const s = run(loaded(doc('', 0)), typed('a'));
    expect(saveDelay(s)).toBe(NOTES_SAVE_DELAY_MS);
    const f = run(s, { type: 'saveStarted' }, { type: 'saveFailed' });
    expect(f.text).toBe('a');
    expect(shouldSave(f)).toBe(true);
    expect(saveDelay(f)).toBe(NOTES_RETRY_DELAY_MS);
    expect(notesStatus(f)).toBe('retrying');
  });

  it('stops at a closed meeting and keeps the text', () => {
    const s = run(
      loaded(doc('', 0)),
      typed('a'),
      { type: 'saveStarted' },
      { type: 'meetingClosed' }
    );
    expect(s.text).toBe('a');
    expect(shouldSave(s)).toBe(false);
    expect(notesStatus(s)).toBe('closed');
  });

  it('does not send text over the limit', () => {
    const s = run(loaded(doc('', 0)), typed('x'.repeat(NOTES_MAX_CHARS + 1)));
    expect(shouldSave(s)).toBe(false);
    expect(notesStatus(s)).toBe('tooLong');
  });
});

describe('the wire', () => {
  it('reads a row and treats no row as version 0', () => {
    expect(parseNotes(null).version).toBe(0);
    expect(
      parseNotes({
        body: 'b',
        version: 4,
        updated_by: 'u',
        updated_at: 't',
      })
    ).toEqual({ body: 'b', version: 4, updatedBy: 'u', updatedAt: 't' });
  });

  it('maps every PUT answer', () => {
    expect(saveAnswer(200, { version: 2, updated_by: 'u' }).type).toBe('saved');
    expect(saveAnswer(409, { error: 'stale', notes: null })).toEqual({
      type: 'stale',
      doc: parseNotes(null),
    });
    expect(saveAnswer(409, { error: 'meeting_closed' }).type).toBe(
      'meetingClosed'
    );
    expect(saveAnswer(500, null).type).toBe('saveFailed');
    expect(saveAnswer(400, { error: 'long' }).type).toBe('saveFailed');
  });
});

describe('who edited', () => {
  it('names another person, never ourselves or a dirty screen', () => {
    const s = loaded(doc('one', 1, 'aisha'));
    expect(editedByOther(s, 'me')?.userId).toBe('aisha');
    expect(editedByOther(s, 'aisha')).toBeNull();
    expect(editedByOther(run(s, typed('x')), 'me')).toBeNull();
    expect(editedByOther(INITIAL_NOTES, 'me')).toBeNull();
  });
});
