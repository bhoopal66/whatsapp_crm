/**
 * Keeping the case page's open Conversation tab up to date. Pure, apart
 * from the calls it is handed.
 *
 * Reading the conversation writes an audit row for a supervisor, so it is
 * never polled: a tick asks the unaudited `?since=` probe whether anything
 * is new, and only then reads. A background read never takes the composer
 * away (it holds unsent text and files): it only replaces what is listed.
 */
import { conversationView, type CaseConversation } from './case-tabs';

export const CONVERSATION_PROBE_MS = 30_000;

/** Only an ACTIVE group with a WhatsApp chat gets new messages. */
export function canRefresh(c: CaseConversation | null): boolean {
  return c !== null && !c.archived && conversationView(c) === 'group';
}

/** `?since=`: the newest message shown, or the epoch for an empty chat. */
export function probeSince(c: CaseConversation): string {
  return c.messages.at(-1)?.created_at ?? new Date(0).toISOString();
}

/**
 * What to show after a re-read. The read is a window of the newest
 * messages, so as new ones arrive it drops rows at the top, which would
 * shift the view of someone reading there: the older rows already shown
 * stay. A window that no longer meets them is taken as it is.
 */
export function mergeConversation(
  shown: CaseConversation,
  fresh: CaseConversation
): CaseConversation {
  const oldest = fresh.messages[0]?.id;
  const at = shown.messages.findIndex((m) => m.id === oldest);
  if (at < 0) return fresh;
  return {
    ...fresh,
    messages: [...shown.messages.slice(0, at), ...fresh.messages],
    truncated: shown.truncated,
  };
}

export type ConversationAnswer =
  | { kind: 'ok'; convo: CaseConversation }
  | { kind: 'notReadable' }
  | { kind: 'failed' };

export interface RefreshIo {
  /** What is on screen now. */
  shown: CaseConversation;
  /** The unaudited probe; rejects when it could not be read. */
  probe: (since: string) => Promise<boolean>;
  /** The audited read. */
  read: () => Promise<ConversationAnswer>;
  /** The tab is still open and on screen. */
  active: () => boolean;
  show: (fresh: CaseConversation) => void;
}

/** One open tab's reads, in the order they were started. */
export class ConversationRefresh {
  private started = 0;
  private applied = 0;
  private stopped = false;
  private ticking = false;

  /** A read is starting (the person's own too): its number. */
  start(): number {
    return ++this.started;
  }

  /**
   * Whether that read's answer may be shown: not when one started after it
   * was shown first. NOT_READABLE stops the ticks (each would audit again)
   * until a read that works.
   */
  settle(read: number, readable: boolean): boolean {
    if (read < this.applied) return false;
    this.applied = read;
    this.stopped = !readable;
    return true;
  }

  /** One probe and, only when something changed, one background read. */
  async tick(io: RefreshIo): Promise<void> {
    if (this.stopped || this.ticking || !canRefresh(io.shown)) return;
    this.ticking = true;
    const before = this.started;
    try {
      if (!(await io.probe(probeSince(io.shown)))) return;
      // Read meanwhile (an own send), or gone: the probe is out of date.
      if (this.started !== before || !io.active()) return;
      const mine = this.start();
      const answer = await io.read();
      if (answer.kind === 'failed') return;
      // A group deleted meanwhile has no composer to show: leave the tab.
      const readable =
        answer.kind === 'ok' && conversationView(answer.convo) === 'group';
      if (this.settle(mine, readable) && answer.kind === 'ok' && readable)
        io.show(answer.convo);
    } catch {
      /* a failed probe changes nothing */
    } finally {
      this.ticking = false;
    }
  }
}
