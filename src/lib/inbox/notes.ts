// ============================================================
// In-chat notes (migration 241): the team's own lines inside a
// customer chat. Never sent, never a message; see the migration header.
//
// Pure helpers for the note composer and the thread: limits, the
// "@name" token being typed, inserting a picked person, which picked
// people are still mentioned when the note is saved, and splitting a
// body into text and mention runs for display.
// ============================================================

/** 241's CHECK: at most this many characters. */
export const NOTE_MAX_LENGTH = 4000;

/** A note as the thread reads it (`conversation_notes`, 241). */
export interface ConversationNote {
  id: string;
  account_id: string;
  conversation_id: string;
  /** Auth user id; null once the author's login is deleted. */
  author_id: string | null;
  body: string;
  /** Who was mentioned and rung when it was saved. */
  mention_ids: string[];
  created_at: string;
  edited_at: string | null;
  /**
   * Set when the author deleted it (332): a tombstone with no text,
   * delivered as an UPDATE so every open chat can drop it.
   */
  deleted_at: string | null;
}

/** Someone an @mention may name (241's conversation_note_mention_candidates). */
export interface MentionCandidate {
  user_id: string;
  full_name: string;
}

/** 241's CHECK, `~ '^[[:space:]]*$'`: blank means nothing but whitespace. */
export function isBlankNote(text: string): boolean {
  return /^\s*$/.test(text);
}

/** Whether `text` may be saved as a note as it stands. */
export function canSaveNote(text: string): boolean {
  return !isBlankNote(text) && text.length <= NOTE_MAX_LENGTH;
}

export interface MentionToken {
  /** What follows the "@", up to the caret. */
  query: string;
  /** Index of the "@". */
  start: number;
  /** The caret: the token runs from `start` to here. */
  end: number;
}

/** Longest name fragment we keep matching after an "@". */
const MAX_QUERY = 40;

/**
 * The "@name" being typed at `caret`, or null. The "@" must open the
 * box or follow whitespace (so an email address never opens the list),
 * and the token may hold spaces ("@Sara Kh") but not a line break.
 */
export function activeMentionToken(
  text: string,
  caret: number
): MentionToken | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (query.length > MAX_QUERY || /[\n\r@]/.test(query)) return null;
  // "@ " is a stray at sign, not the start of a name.
  if (/^\s/.test(query)) return null;
  return { query, start: at, end: before.length };
}

/** Candidates whose name has a word starting with the query, best first. */
export function filterMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
  limit = 6
): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  const named = candidates.filter((c) => c.full_name.trim() !== '');
  if (q === '') return named.slice(0, limit);
  const starts: MentionCandidate[] = [];
  const words: MentionCandidate[] = [];
  for (const c of named) {
    const name = c.full_name.toLowerCase();
    if (name.startsWith(q)) starts.push(c);
    else if (name.split(/\s+/).some((w) => w.startsWith(q))) words.push(c);
  }
  return [...starts, ...words].slice(0, limit);
}

/** Replace the typed token with "@Full Name " and say where the caret goes. */
export function insertMention(
  text: string,
  token: MentionToken,
  name: string
): { text: string; caret: number } {
  const inserted = `@${name.trim()} `;
  const after = text.slice(token.end).replace(/^ /, '');
  return {
    text: text.slice(0, token.start) + inserted + after,
    caret: token.start + inserted.length,
  };
}

function mentionPattern(name: string): RegExp {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Not followed by a letter or digit, so "@Sam" does not match "@Samir".
  return new RegExp(`(^|\\s)@${escaped}(?![\\p{L}\\p{N}])`, 'u');
}

/** 241 refuses a note naming more people (trigger and CHECK). */
export const NOTE_MAX_MENTIONS = 20;

/**
 * The picked people still named in `body` as "@Full Name", each once,
 * in picking order, at most NOTE_MAX_MENTIONS. Someone picked and then
 * deleted from the text is not rung.
 */
export function mentionedIds(
  body: string,
  picked: readonly MentionCandidate[]
): string[] {
  const out: string[] = [];
  for (const p of picked) {
    if (out.length >= NOTE_MAX_MENTIONS) break;
    if (!p.full_name.trim() || out.includes(p.user_id)) continue;
    if (mentionPattern(p.full_name).test(body)) out.push(p.user_id);
  }
  return out;
}

export interface NoteSegment {
  text: string;
  mention: boolean;
}

/**
 * Split a body into plain text and "@Full Name" runs for `names` (the
 * people the note rang), longest name first so "@Sara Khan" wins over
 * "@Sara".
 */
export function splitNoteMentions(
  body: string,
  names: readonly string[]
): NoteSegment[] {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length
  );
  if (clean.length === 0) return [{ text: body, mention: false }];
  const alt = clean
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const re = new RegExp(`@(?:${alt})(?![\\p{L}\\p{N}])`, 'gu');
  const out: NoteSegment[] = [];
  let last = 0;
  for (const m of body.matchAll(re)) {
    const i = m.index ?? 0;
    // Only at the start or after whitespace, as typed.
    if (i > 0 && !/\s/.test(body[i - 1]!)) continue;
    if (i > last) out.push({ text: body.slice(last, i), mention: false });
    out.push({ text: m[0], mention: true });
    last = i + m[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last), mention: false });
  return out.length ? out : [{ text: body, mention: false }];
}

/** Put `row` into `notes` (insert or replace by id), oldest first. */
export function mergeNote(
  notes: readonly ConversationNote[],
  row: ConversationNote
): ConversationNote[] {
  const rest = notes.filter((n) => n.id !== row.id);
  return [...rest, row].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
}

/** A `conversation_notes` realtime payload, as far as the thread reads it. */
export interface NoteChangeEvent {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new?: Partial<ConversationNote> | null;
}

/**
 * The chat's notes after one realtime change from the chat's filtered
 * subscription. A delete arrives as an UPDATE that sets `deleted_at`
 * (332's tombstone), so the note is dropped by id; one this chat does
 * not hold, or already dropped, returns the same list. A row of another
 * chat changes nothing. A hard DELETE (the PDPL erase) carries only the
 * id and is never delivered through a filter, so it is ignored here and
 * shows on the next read.
 */
export function applyNoteChange(
  notes: ConversationNote[],
  conversationId: string,
  event: NoteChangeEvent
): ConversationNote[] {
  if (event.eventType === 'DELETE') return notes;
  const row = event.new;
  if (!row?.id || row.conversation_id !== conversationId) return notes;
  if (row.deleted_at) {
    if (!notes.some((n) => n.id === row.id)) return notes;
    return notes.filter((n) => n.id !== row.id);
  }
  return mergeNote(notes, row as ConversationNote);
}
