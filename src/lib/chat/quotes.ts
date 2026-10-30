/**
 * Quote replies in team chat (migration 156's `reply_to_id`), pure.
 *
 * The database allows a quote only inside the same channel and thread
 * scope, so a timeline's quotes are mostly of messages it already holds;
 * the rest (older than the loaded page) are read by id. RLS hands back
 * only what the viewer may read, so an id it leaves out is shown as
 * unavailable, never retried. What is read is kept current from the
 * workspace's realtime message events (patch / invalidate).
 */
import { formatClock as formatLength } from '@/lib/media/voice-waveform';

import { plainText } from './format';
import { mergeMessage, type MessageEvent } from './message-list';
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

/** The waits before each retry of a failed quote read. */
export const QUOTE_RETRY_DELAYS_MS = [1_000, 3_000, 9_000] as const;

/**
 * The wait before the next read of an id whose reads failed `failures`
 * times in a row; null once the retries are spent (the id is then shown
 * as unavailable instead of loading for good).
 */
export function quoteRetryDelay(failures: number): number | null {
  if (failures < 1) return 0;
  return QUOTE_RETRY_DELAYS_MS[failures - 1] ?? null;
}

/**
 * One timeline's quoted messages read from the server: each id is asked
 * for once, and one the server does not return is remembered as
 * unavailable. A failed read forgets its ids, so they are asked again
 * (retryDelay says when), until QUOTE_RETRY_DELAYS_MS is spent and they
 * are unavailable.
 */
export class QuoteStore {
  private readonly asked = new Set<string>();
  private readonly found = new Map<string, ChatMessage | null>();
  private readonly failures = new Map<string, number>();
  /** Asked, in flight, and changed since: the read's answer is stale. */
  private readonly stale = new Set<string>();

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

  /**
   * When to ask again for those of `ids` a failed read left unasked: the
   * longest of their waits; null when none is waiting on a retry.
   */
  retryDelay(ids: readonly string[]): number | null {
    let wait: number | null = null;
    for (const id of this.unasked(ids)) {
      const n = this.failures.get(id);
      const d = n ? quoteRetryDelay(n) : null;
      if (d !== null) wait = Math.max(wait ?? 0, d);
    }
    return wait;
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
      let learned = false;
      for (const id of fresh) {
        const n = (this.failures.get(id) ?? 0) + 1;
        this.failures.set(id, n);
        this.stale.delete(id);
        if (quoteRetryDelay(n) === null) {
          this.found.set(id, null);
          learned = true;
        } else this.asked.delete(id);
      }
      return learned;
    }
    const byId = new Map(rows.map((m) => [m.id, m]));
    for (const id of fresh) {
      this.failures.delete(id);
      if (this.stale.delete(id)) this.asked.delete(id);
      else this.found.set(id, byId.get(id) ?? null);
    }
    return true;
  }

  /**
   * A realtime insert/update of a message: a quote already read takes
   * it (edited, removed or erased); one still in flight is read again.
   * True when what `get` answers changed or a read is now due.
   */
  patch(message: ChatMessage): boolean {
    const prev = this.found.get(message.id);
    if (prev) {
      this.found.set(message.id, mergeMessage(prev, message));
      return true;
    }
    // Unavailable before, or never read: the row event has no
    // attachments, so a full read is what shows it right.
    return this.asked.has(message.id) ? this.invalidate(message.id) : false;
  }

  /** Forgets a quote (a realtime delete), so it is read again. */
  invalidate(id: string): boolean {
    if (!this.asked.has(id)) return false;
    this.failures.delete(id);
    if (this.found.delete(id)) {
      this.asked.delete(id);
      return true;
    }
    this.stale.add(id);
    return false;
  }
}

/**
 * The composer's held "Replying to" message after a realtime message
 * event: the same object when the event is about another message; the
 * event's copy merged in when it is this one (edited, removed or
 * erased, which the bar then shows); null once the row is deleted.
 */
export function replyTargetAfterEvent(
  target: ChatMessage | null,
  event: MessageEvent
): ChatMessage | null {
  if (!target) return target;
  if (event.type === 'delete') return event.id === target.id ? null : target;
  return event.message.id === target.id
    ? mergeMessage(target, event.message)
    : target;
}
