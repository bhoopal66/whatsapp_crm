// ============================================================
// The in-call panel's draft (call-note.ts) with its saves: debounced,
// one at a time, queued until the call's row is there. And the draft a
// panel leaves behind unsaved: kept in the session cache, so in memory
// only and wiped at sign-out, until a panel of that call takes it back.
// ============================================================

import {
  mayFetchSessionKey,
  sessionCache,
  type SessionKey,
} from '@/lib/session-cache';
import {
  NEW_NOTE,
  isUnsaved,
  onRow,
  onSaved,
  onSend,
  restored,
  saveBody,
  type NoteAnswer,
  type NoteBody,
  type NoteDraft,
} from './call-note';

export const NOTE_SAVE_DELAY_MS = 800;
/** A save with no answer by then counts as lost: Close must not hang. */
export const NOTE_SAVE_TIMEOUT_MS = 20_000;

/** PATCH /api/pbx/calls/{callId}; null when no answer of it came. */
export async function sendCallNote(
  callId: string,
  body: NoteBody
): Promise<NoteAnswer | null> {
  try {
    const res = await fetch(`/api/pbx/calls/${callId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(NOTE_SAVE_TIMEOUT_MS),
    });
    // Not JSON (a sign-in page after a redirect, a cut answer) is no
    // answer: it may have been saved or not.
    const b = (await res.json()) as Partial<NoteAnswer>;
    return { status: res.status, conflict: b.conflict, notes: b.notes };
  } catch {
    return null;
  }
}

export interface CallNoteStore {
  get: () => NoteDraft;
  subscribe: (listener: () => void) => () => void;
  /** Changes the draft and saves it, after the typing pause by default. */
  edit: (fn: (d: NoteDraft) => NoteDraft, when?: 'soon' | 'now') => void;
  /** The call's row arrived: fills an untouched panel, sends the queue. */
  row: (id: string, row: Parameters<typeof onRow>[1]) => void;
  /** Saves now; resolves once every save so far was answered. */
  save: () => Promise<void>;
}

export function createCallNote(
  initial: NoteDraft = NEW_NOTE,
  send: typeof sendCallNote = sendCallNote
): CallNoteStore {
  let draft = initial;
  let callId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const set = (d: NoteDraft) => {
    if (d === draft) return;
    draft = d;
    for (const l of [...listeners]) l();
  };
  const run = async () => {
    for (let again = true; again;) {
      const body = saveBody(draft);
      if (!callId || !body) return;
      set(onSend(draft, body));
      const answer = await send(callId, body);
      // `draft` read after it: it may have been typed on meanwhile.
      const next = onSaved(draft, body, answer);
      again = next.retry;
      set(next.draft);
    }
  };
  const save = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    chain = chain.then(run);
    return chain;
  };
  return {
    get: () => draft,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    edit: (fn, when = 'soon') => {
      set(fn(draft));
      if (when === 'now') return void save();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void save(), NOTE_SAVE_DELAY_MS);
    },
    row: (id, row) => {
      const first = callId === null;
      callId = id;
      set(onRow(draft, row));
      if (first && isUnsaved(draft)) void save();
    },
    save,
  };
}

/** The draft kept for this panel, without taking it. */
export const keptCallNote = (key: SessionKey | null): NoteDraft | null => {
  const entry = key && sessionCache.peek<NoteDraft>(key);
  return entry ? restored(entry.value) : null;
};

/** A panel has it now. A delete counts as a wipe, so only a kept one. */
export function dropKeptCallNote(key: SessionKey | null): void {
  if (key && sessionCache.peek(key)) sessionCache.delete(key);
}

/**
 * The panel is leaving: an unsaved draft is kept before anything else,
 * then saved once more (`tried`: that just failed), and only if it still
 * is not saved is the person told (`show`). `hide` runs when the kept
 * draft is gone: taken by a panel, saved, or wiped at sign-out.
 */
export async function keepCallNote(
  key: SessionKey | null,
  note: CallNoteStore,
  opts: { tried: boolean; show: () => void; hide: () => void }
): Promise<void> {
  // After a sign-out nothing of it may be put back.
  if (!key || !isUnsaved(note.get()) || !mayFetchSessionKey(key)) return;
  const put = (d: NoteDraft) => {
    sessionCache.set(key, d);
    return d;
  };
  // About to be sent, so a panel that takes it back meanwhile must know
  // the text for its own.
  const body = opts.tried ? null : saveBody(note.get());
  let mine = put(body ? onSend(note.get(), body) : note.get());
  // Subscribed, so the cache does not evict it either.
  const off = sessionCache.subscribe(key, () => {
    if (sessionCache.peek(key)) return;
    off();
    opts.hide();
  });
  if (!opts.tried) await note.save();
  if (sessionCache.peek(key)?.value !== mine) return;
  if (!isUnsaved(note.get())) return sessionCache.delete(key);
  mine = put(note.get());
  opts.show();
}
