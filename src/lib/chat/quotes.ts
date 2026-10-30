/**
 * Quote replies in team chat (migration 156's `reply_to_id`), pure.
 *
 * The database allows a quote only inside the same channel and thread
 * scope, so a timeline's quotes are mostly of messages it already holds;
 * the rest (older than the loaded page) are read once by id. RLS hands
 * back only what the viewer may read, so an id it leaves out is shown
 * as unavailable, never retried.
 */
import { formatClock as formatLength } from '@/lib/media/voice-waveform';

import { plainText } from './format';
import type { ChatMessage, ChatPerson } from './types';
import { boldSegments } from './view';
import { hidesVoiceBody } from './voice';

type People = ReadonlyArray<Pick<ChatPerson, 'userId' | 'fullName'>>;

/** The longest one-line preview of a quoted message, ellipsis included. */
export const QUOTE_PREVIEW_MAX = 140;

/**
 * The quoted ids a timeline still has to read: distinct, in first-seen
 * order, of live messages, and not among the loaded ones.
 */
export function quoteIds(
  messages: ReadonlyArray<
    Pick<ChatMessage, 'id' | 'replyToId' | 'deletedAt' | 'erasedAt'>
  >
): string[] {
  const loaded = new Set(messages.map((m) => m.id));
  const out = new Set<string>();
  for (const m of messages)
    if (m.replyToId && !m.deletedAt && !m.erasedAt && !loaded.has(m.replyToId))
      out.add(m.replyToId);
  return [...out];
}

export type QuoteKind =
  'text' | 'voice' | 'file' | 'deleted' | 'erased' | 'unavailable';

export interface QuotePreview {
  kind: QuoteKind;
  /** text: the one-line body; voice: its m:ss length; file: the first name; else ''. */
  text: string;
  /** Null for a system post or an unavailable message. */
  authorId: string | null;
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > QUOTE_PREVIEW_MAX
    ? `${flat.slice(0, QUOTE_PREVIEW_MAX - 1).trimEnd()}…`
    : flat;
}

/**
 * What the quote block above a reply shows. `target` null = the server
 * did not return it (not readable, or gone).
 */
export function quotePreview(
  target: ChatMessage | null,
  people: People,
  unknownName = '?'
): QuotePreview {
  if (!target) return { kind: 'unavailable', text: '', authorId: null };
  const authorId = target.authorKind === 'system' ? null : target.authorId;
  if (target.erasedAt) return { kind: 'erased', text: '', authorId };
  if (target.deletedAt) return { kind: 'deleted', text: '', authorId };
  const voice = target.attachments.find((a) => a.kind === 'voice');
  const length = () => formatLength((voice?.durationMs ?? 0) / 1000);
  if (hidesVoiceBody(target))
    return { kind: 'voice', text: length(), authorId };
  const text = oneLine(
    target.authorKind === 'system'
      ? boldSegments(target.body)
          .map((s) => s.text)
          .join('')
      : plainText(target.body, people, unknownName)
  );
  if (text) return { kind: 'text', text, authorId };
  if (voice) return { kind: 'voice', text: length(), authorId };
  if (target.attachments.length > 0)
    return { kind: 'file', text: target.attachments[0].name, authorId };
  return { kind: 'text', text: '', authorId };
}

/**
 * One timeline's quoted messages read from the server: each id is asked
 * for at most once, and one the server does not return is remembered as
 * unavailable. A failed read forgets its ids, so a later change of the
 * timeline may ask again.
 */
export class QuoteStore {
  private readonly asked = new Set<string>();
  private readonly found = new Map<string, ChatMessage | null>();

  constructor(
    private readonly fetch: (ids: string[]) => Promise<ChatMessage[]>
  ) {}

  /** The message; null when unavailable; undefined while not yet read. */
  get(id: string): ChatMessage | null | undefined {
    return this.found.get(id);
  }

  /** The ids not asked for yet. */
  unasked(ids: readonly string[]): string[] {
    return ids.filter((id) => !this.asked.has(id));
  }

  /** Reads the ids not asked for yet; true when anything was learned. */
  async request(ids: readonly string[]): Promise<boolean> {
    const fresh = [...new Set(this.unasked(ids))];
    if (fresh.length === 0) return false;
    for (const id of fresh) this.asked.add(id);
    let rows: ChatMessage[];
    try {
      rows = await this.fetch(fresh);
    } catch {
      for (const id of fresh) this.asked.delete(id);
      return false;
    }
    const byId = new Map(rows.map((m) => [m.id, m]));
    for (const id of fresh) this.found.set(id, byId.get(id) ?? null);
    return true;
  }
}
