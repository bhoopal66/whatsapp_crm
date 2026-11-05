// The shared meeting notes, as a pure state machine. Two people can type
// at once and the server keeps one body per version, so the rule here is
// that what someone typed never leaves the screen without their say-so.

import { NOTES_MAX } from '@/lib/meetings/requests';

export const NOTES_MAX_CHARS = NOTES_MAX;
/** The character counter shows once the text is this close to the limit. */
export const NOTES_COUNTER_FROM = 1_000;
export const NOTES_SAVE_DELAY_MS = 1_200;
export const NOTES_RETRY_DELAY_MS = 5_000;
export const NOTES_POLL_MS = 5_000;

/** The saved notes; version 0 means no row yet. */
export interface NotesDoc {
  body: string;
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export const EMPTY_NOTES: NotesDoc = {
  body: '',
  version: 0,
  updatedBy: null,
  updatedAt: null,
};

export interface NotesState {
  /** False until the first GET: the base version is not known before it. */
  loaded: boolean;
  /** What is on screen. */
  text: string;
  /** The saved version the text was written against. */
  base: NotesDoc;
  /** The text of the PUT in flight, or null. */
  sending: string | null;
  /** The last save failed for a reason a retry can cure. */
  failed: boolean;
  /** A newer version the person has not decided about. */
  conflict: NotesDoc | null;
  /** The meeting closed: nothing more can be saved. */
  closed: boolean;
}

export const INITIAL_NOTES: NotesState = {
  loaded: false,
  text: '',
  base: EMPTY_NOTES,
  sending: null,
  failed: false,
  conflict: null,
  closed: false,
};

export type NotesEvent =
  | { type: 'typed'; text: string }
  | { type: 'polled'; doc: NotesDoc }
  | { type: 'saveStarted' }
  | { type: 'saved'; doc: Omit<NotesDoc, 'body'> }
  | { type: 'stale'; doc: NotesDoc }
  | { type: 'saveFailed' }
  | { type: 'meetingClosed' }
  | { type: 'seeTheirs' }
  | { type: 'keepMine' };

export const isDirty = (s: NotesState): boolean => s.text !== s.base.body;

/** A newer version reached us while the text may differ from our base. */
function receive(s: NotesState, doc: NotesDoc): NotesState {
  if (s.text === doc.body || !isDirty(s)) {
    return { ...s, text: doc.body, base: doc, conflict: null, failed: false };
  }
  return { ...s, conflict: doc };
}

export function notesReducer(s: NotesState, e: NotesEvent): NotesState {
  switch (e.type) {
    case 'typed':
      return { ...s, text: e.text };
    case 'polled': {
      const r = s.loaded ? s : { ...s, loaded: true };
      // A read during our own save may show that save: its answer decides.
      if (r.sending !== null || e.doc.version <= r.base.version) return r;
      return receive(r, e.doc);
    }
    case 'saveStarted':
      return { ...s, sending: s.text };
    case 'saved':
      return {
        ...s,
        sending: null,
        failed: false,
        base: { ...e.doc, body: s.sending ?? s.base.body },
      };
    case 'stale':
      return receive({ ...s, sending: null, failed: false }, e.doc);
    case 'saveFailed':
      return { ...s, sending: null, failed: true };
    case 'meetingClosed':
      return { ...s, sending: null, failed: false, closed: true };
    case 'seeTheirs':
      return s.conflict
        ? { ...s, text: s.conflict.body, base: s.conflict, conflict: null }
        : s;
    case 'keepMine':
      // The next save goes in at their version, so it lands over theirs.
      return s.conflict ? { ...s, base: s.conflict, conflict: null } : s;
  }
}

export const isOverLimit = (s: NotesState): boolean =>
  s.text.length > NOTES_MAX_CHARS;

/** Whether a PUT may go now. An open conflict waits for the person. */
export function shouldSave(s: NotesState): boolean {
  return (
    s.loaded &&
    isDirty(s) &&
    s.sending === null &&
    s.conflict === null &&
    !s.closed &&
    !isOverLimit(s)
  );
}

export const saveDelay = (s: NotesState): number =>
  s.failed ? NOTES_RETRY_DELAY_MS : NOTES_SAVE_DELAY_MS;

export type NotesStatus =
  'loading' | 'closed' | 'tooLong' | 'retrying' | 'saving' | 'saved' | 'idle';

export function notesStatus(s: NotesState): NotesStatus {
  if (!s.loaded) return 'loading';
  if (s.closed) return 'closed';
  if (isOverLimit(s)) return 'tooLong';
  if (s.failed) return 'retrying';
  if (s.sending !== null || isDirty(s)) return 'saving';
  return s.base.version > 0 ? 'saved' : 'idle';
}

/** Who to credit under the text: someone else's version, shown as saved. */
export function editedByOther(
  s: NotesState,
  selfUserId: string | null
): { userId: string | null; at: string } | null {
  const { updatedBy, updatedAt } = s.base;
  if (!updatedAt || isDirty(s) || updatedBy === selfUserId) return null;
  return { userId: updatedBy, at: updatedAt };
}

const asText = (v: unknown): string | null =>
  typeof v === 'string' ? v : null;

/** A `notes` object off the wire; null or malformed means no row yet. */
export function parseNotes(raw: unknown): NotesDoc {
  if (!raw || typeof raw !== 'object') return EMPTY_NOTES;
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== 'number') return EMPTY_NOTES;
  return {
    body: asText(r.body) ?? '',
    version: r.version,
    updatedBy: asText(r.updated_by),
    updatedAt: asText(r.updated_at),
  };
}

/** The event a PUT's answer amounts to. */
export function saveAnswer(status: number, json: unknown): NotesEvent {
  const r = (json && typeof json === 'object' ? json : {}) as Record<
    string,
    unknown
  >;
  if (status >= 200 && status < 300 && typeof r.version === 'number') {
    const { version, updatedBy, updatedAt } = parseNotes(r);
    return { type: 'saved', doc: { version, updatedBy, updatedAt } };
  }
  if (status === 409 && r.error === 'stale') {
    return { type: 'stale', doc: parseNotes(r.notes) };
  }
  if (status === 409 && r.error === 'meeting_closed') {
    return { type: 'meetingClosed' };
  }
  return { type: 'saveFailed' };
}
