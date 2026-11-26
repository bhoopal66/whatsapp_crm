import { afterEach, describe, expect, it } from 'vitest';

import { chatDrafts, keptKey, keptNotes, unsavedMinutes } from './kept';
import {
  EMPTY_NOTES,
  INITIAL_NOTES,
  notesReducer,
  type NotesState,
} from './notes';

afterEach(() => {
  keptNotes.clear();
  chatDrafts.clear();
});

const loaded = (): NotesState =>
  notesReducer(INITIAL_NOTES, { type: 'polled', doc: EMPTY_NOTES });

describe('unsavedMinutes', () => {
  it('gives the typed text a conflict kept off the server, per person and meeting', () => {
    let s = loaded();
    s = notesReducer(s, { type: 'typed', text: 'my minutes' });
    s = notesReducer(s, {
      type: 'polled',
      doc: { body: 'theirs', version: 3, updatedBy: 'u2', updatedAt: null },
    });
    expect(s.conflict).not.toBeNull();
    keptNotes.set(keptKey('u1', 'm1'), s);
    expect(unsavedMinutes('u1', 'm1')).toBe('my minutes');
    expect(unsavedMinutes('u2', 'm1')).toBeNull();
    expect(unsavedMinutes('u1', 'm2')).toBeNull();
  });

  it('is null for text that is saved or blank', () => {
    const saved = notesReducer(loaded(), { type: 'typed', text: '' });
    keptNotes.set(keptKey('u1', 'm1'), saved);
    expect(unsavedMinutes('u1', 'm1')).toBeNull();
    keptNotes.set(
      keptKey('u1', 'm1'),
      notesReducer(loaded(), { type: 'typed', text: '   ' })
    );
    expect(unsavedMinutes('u1', 'm1')).toBeNull();
  });
});
