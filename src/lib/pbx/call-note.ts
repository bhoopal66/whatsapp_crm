// ============================================================
// The in-call panel's outcome and note while they are being written
// (module 015, migration 294): a pure reducer, so the panel can neither
// lose a text nor overwrite one it never read. Client-safe, no I/O.
//
// A note is saved with the text it was written over (`seen`); the route
// answers 409 `conflict` when the stored note is another one. A save
// whose answer was lost may have been stored, so its text is kept
// (`sent`): a conflict with one of our own texts is our own save.
// ============================================================

import type { Outcome } from './call-ui';

export interface NoteDraft {
  notes: string;
  outcome: Outcome | null;
  /** `notes` / `outcome` is not known to be stored. */
  notesDirty: boolean;
  outcomeDirty: boolean;
  /** The stored note the text was written over; null: an empty one. */
  seen: string | null;
  /** The call's row was read once; nothing is adopted from it again. */
  loaded: boolean;
  /** Texts sent whose answer never came: they may be stored. */
  sent: (string | null)[];
  /** The stored note a save ran into, until the person picks one. */
  conflict: { theirs: string | null } | null;
  saving: boolean;
  /** Why the last save did not go through. */
  failed: 'lost' | 'refused' | null;
}

export const NEW_NOTE: NoteDraft = {
  notes: '',
  outcome: null,
  notesDirty: false,
  outcomeDirty: false,
  seen: null,
  loaded: false,
  sent: [],
  conflict: null,
  saving: false,
  failed: null,
};

/** The PATCH body: only what is to be written. */
export interface NoteBody {
  disposition?: Outcome | null;
  notes?: string;
  notesSeen?: string | null;
}

/** The route's answer; null when none came (or it was not the route's). */
export interface NoteAnswer {
  status: number;
  conflict?: boolean;
  notes?: string | null;
}

/** A text as the database stores it (btrim, '' as null). */
export const storedText = (v: string | null | undefined): string | null =>
  (v ?? '').replace(/^ +| +$/g, '') || null;

export const onNotes = (d: NoteDraft, notes: string): NoteDraft => ({
  ...d,
  notes,
  // A text whose answer is still out may be stored: typing back to what
  // was seen must still be sent.
  notesDirty: storedText(notes) !== d.seen || d.sent.length > 0,
});

export const onOutcome = (
  d: NoteDraft,
  outcome: Outcome | null
): NoteDraft => ({ ...d, outcome, outcomeDirty: true });

/**
 * The call's row arrived. Only the first one fills the panel, and only
 * what was not touched yet: text typed before it keeps `seen` null, so a
 * stored note shows as a conflict instead of being replaced.
 */
export function onRow(
  d: NoteDraft,
  row: { disposition: Outcome | null; notes: string | null }
): NoteDraft {
  if (d.loaded) return d;
  return {
    ...d,
    loaded: true,
    outcome: d.outcomeDirty ? d.outcome : row.disposition,
    ...(!d.notesDirty && {
      notes: row.notes ?? '',
      seen: storedText(row.notes),
    }),
  };
}

/** What there is to save now; null for nothing (or only a conflict). */
export function saveBody(d: NoteDraft): NoteBody | null {
  const body: NoteBody = {};
  if (d.outcomeDirty) body.disposition = d.outcome;
  if (d.notesDirty && !d.conflict) {
    body.notes = d.notes;
    body.notesSeen = d.seen;
  }
  return Object.keys(body).length ? body : null;
}

/** `body` is on its way: until it is answered it may be stored. */
export const onSend = (d: NoteDraft, body: NoteBody): NoteDraft => ({
  ...d,
  saving: true,
  failed: null,
  sent: body.notes === undefined ? d.sent : [...d.sent, storedText(body.notes)],
});

/** `body` was answered. `retry`: there is something to send at once. */
export function onSaved(
  d: NoteDraft,
  body: NoteBody,
  answer: NoteAnswer | null
): { draft: NoteDraft; retry: boolean } {
  const next: NoteDraft = { ...d, saving: false, failed: null };
  const done = (draft: NoteDraft, retry = false) => ({ draft, retry });
  if (!answer || answer.status >= 500) return done({ ...next, failed: 'lost' });

  // Answered: this text is no longer a maybe (one copy of it).
  if (body.notes !== undefined) {
    const at = d.sent.lastIndexOf(storedText(body.notes));
    next.sent = d.sent.filter((_, i) => i !== at);
  }
  if (answer.status === 409 && answer.conflict) {
    const theirs = storedText(answer.notes);
    if (theirs === storedText(next.notes)) {
      const draft = { ...next, seen: theirs, sent: [], notesDirty: false };
      return done(draft, draft.outcomeDirty);
    }
    // Our own earlier save, stored though its answer was lost. Emptying
    // `sent` is what stops a second conflict from retrying again.
    if (next.sent.includes(theirs))
      return done({ ...next, seen: theirs, sent: [] }, true);
    // Nothing of the body was written: an outcome goes again, alone.
    return done({ ...next, conflict: { theirs } }, next.outcomeDirty);
  }
  if (answer.status < 200 || answer.status > 299)
    return done({ ...next, failed: 'refused' });

  if (body.disposition !== undefined)
    next.outcomeDirty = d.outcome !== body.disposition;
  if (body.notes !== undefined) {
    next.seen = storedText(body.notes);
    next.sent = [];
    next.notesDirty = storedText(d.notes) !== next.seen;
  }
  return done(next);
}

/** The person's own text stays, over the one shown. */
export const keepMine = (d: NoteDraft): NoteDraft =>
  d.conflict ? { ...d, seen: d.conflict.theirs, conflict: null } : d;

/** The stored text replaces the person's. */
export const keepTheirs = (d: NoteDraft): NoteDraft =>
  d.conflict
    ? {
        ...d,
        notes: d.conflict.theirs ?? '',
        seen: d.conflict.theirs,
        notesDirty: false,
        sent: [],
        conflict: null,
      }
    : d;

export const isUnsaved = (d: NoteDraft): boolean =>
  d.notesDirty || d.outcomeDirty;

/**
 * Closing the panel, its last save answered: `stay` for a person's
 * Close, to try again; `keep` for the wrap-up's own, which closes with
 * the draft put by.
 */
export const closeDecision = (
  d: NoteDraft,
  auto: boolean
): 'close' | 'stay' | 'keep' =>
  !isUnsaved(d) ? 'close' : auto ? 'keep' : 'stay';

/** A draft put by, as a panel opens on it again. */
export const restored = (d: NoteDraft): NoteDraft => ({ ...d, saving: false });
