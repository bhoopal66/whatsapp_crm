/**
 * Pure timeline state for one channel (or one thread panel). The UI
 * feeds it pages from `listMessages` and events from `subscribeChat`;
 * everything order-, dedupe- and thread-related lives here so it is
 * unit-tested rather than discovered in the browser.
 *
 * The list is a contiguous window: the newest messages back to the
 * oldest page loaded. An event for a message older than that window is
 * dropped (loading the older page brings it), never spliced in.
 */
import type {
  ChatAttachment,
  ChatMessage,
  MessagePage,
  ReactionSummary,
  ThreadReplyRef,
  ThreadSummary,
} from './types';

export interface TimelineState {
  channelId: string;
  /** Set for a thread panel: the list is this root's replies. */
  threadRootId: string | null;
  /** Oldest first. */
  messages: ChatMessage[];
  hasMoreOlder: boolean;
}

export type MessageEvent =
  | { type: 'insert' | 'update'; message: ChatMessage }
  | { type: 'delete'; id: string };

export type ReactionEvent = {
  type: 'add' | 'remove';
  messageId: string;
  userId: string;
  emoji: string;
};

export function createTimeline(
  channelId: string,
  threadRootId: string | null = null
): TimelineState {
  return { channelId, threadRootId, messages: [], hasMoreOlder: true };
}

/**
 * Sortable key with microsecond precision for a timestamptz string, in
 * either PostgREST ('…T…+00:00') or Postgres text ('… …+00') form.
 */
export function timestampKey(ts: string): number {
  let iso = ts.trim().replace(' ', 'T');
  if (/[+-]\d{2}$/.test(iso)) iso += ':00';
  const frac = /\.(\d+)/.exec(iso)?.[1] ?? '';
  const micros = Number(frac.padEnd(6, '0').slice(3, 6));
  return Date.parse(iso.replace(/(\.\d{3})\d+/, '$1')) * 1000 + micros;
}

export function compareMessages(
  a: Pick<ChatMessage, 'createdAt' | 'id'>,
  b: Pick<ChatMessage, 'createdAt' | 'id'>
): number {
  const d = timestampKey(a.createdAt) - timestampKey(b.createdAt);
  return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The summary of these replies; null when there are none. */
export function summarizeReplies(
  replies: readonly ThreadReplyRef[]
): ThreadSummary | null {
  if (replies.length === 0) return null;
  const sorted = [...replies].sort(compareMessages);
  const authorIds: string[] = [];
  for (let i = sorted.length - 1; i >= 0 && authorIds.length < 3; i--) {
    const a = sorted[i].authorId;
    if (a && !authorIds.includes(a)) authorIds.push(a);
  }
  return {
    replyCount: sorted.length,
    lastReplyAt: sorted[sorted.length - 1].createdAt,
    authorIds,
    replies: sorted,
  };
}

/** Root with `reply` counted (or uncounted once deleted); the same object when nothing changes. */
function withReply(root: ChatMessage, reply: ChatMessage): ChatMessage {
  const refs = root.thread?.replies ?? [];
  const counted = refs.some((r) => r.id === reply.id);
  if (counted !== Boolean(reply.deletedAt)) return root;
  const next = reply.deletedAt
    ? refs.filter((r) => r.id !== reply.id)
    : [
        ...refs,
        { id: reply.id, authorId: reply.authorId, createdAt: reply.createdAt },
      ];
  return { ...root, thread: summarizeReplies(next) };
}

const replaceAt = <T>(list: readonly T[], i: number, item: T): T[] => {
  const out = list.slice();
  out[i] = item;
  return out;
};

/** A fresh row merged over what the list holds: row fields from `next`, details kept unless `next` brings its own. */
function mergeMessage(prev: ChatMessage, next: ChatMessage): ChatMessage {
  if (next.deletedAt)
    return { ...next, attachments: [], reactions: [], thread: prev.thread };
  return {
    ...next,
    attachments: next.attachments.length ? next.attachments : prev.attachments,
    reactions: next.reactions.length ? next.reactions : prev.reactions,
    thread: next.thread ?? prev.thread,
  };
}

function insertSorted(
  list: readonly ChatMessage[],
  m: ChatMessage
): ChatMessage[] {
  let i = list.length;
  while (i > 0 && compareMessages(list[i - 1], m) > 0) i--;
  return [...list.slice(0, i), m, ...list.slice(i)];
}

export function applyMessageEvent(
  state: TimelineState,
  event: MessageEvent
): TimelineState {
  if (event.type === 'delete') {
    const i = state.messages.findIndex((x) => x.id === event.id);
    return i < 0
      ? state
      : { ...state, messages: state.messages.filter((x) => x.id !== event.id) };
  }
  const m = event.message;
  if (m.channelId !== state.channelId) return state;

  const belongs = state.threadRootId
    ? m.threadRootId === state.threadRootId
    : m.threadRootId === null;
  if (!belongs) {
    // A reply, seen from the main list: it only updates its root's summary.
    if (state.threadRootId || !m.threadRootId) return state;
    const r = state.messages.findIndex((x) => x.id === m.threadRootId);
    if (r < 0) return state;
    const root = withReply(state.messages[r], m);
    return root === state.messages[r]
      ? state
      : { ...state, messages: replaceAt(state.messages, r, root) };
  }

  const i = state.messages.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    return {
      ...state,
      messages: replaceAt(
        state.messages,
        i,
        mergeMessage(state.messages[i], m)
      ),
    };
  }
  const oldest = state.messages[0];
  if (state.hasMoreOlder && oldest && compareMessages(m, oldest) < 0)
    return state;
  return { ...state, messages: insertSorted(state.messages, m) };
}

/** Adds a page (the first or an older one). A message already held wins over the page's copy. */
export function mergePage(
  state: TimelineState,
  page: MessagePage
): TimelineState {
  const held = new Set(state.messages.map((m) => m.id));
  const fresh = page.messages.filter(
    (m) =>
      !held.has(m.id) &&
      m.channelId === state.channelId &&
      m.threadRootId === state.threadRootId
  );
  return {
    ...state,
    messages: [...state.messages, ...fresh].sort(compareMessages),
    hasMoreOlder: page.hasMore,
  };
}

/** Messages with details from attachmentsFor / reactionsFor / threadSummaries filled in. */
export function withDetails(
  messages: readonly ChatMessage[],
  details: {
    attachments?: Record<string, ChatAttachment[]>;
    reactions?: Record<string, ReactionSummary[]>;
    threads?: Record<string, ThreadSummary>;
  }
): ChatMessage[] {
  return messages.map((m) => ({
    ...m,
    attachments: details.attachments?.[m.id] ?? m.attachments,
    reactions: details.reactions?.[m.id] ?? m.reactions,
    thread: details.threads?.[m.id] ?? m.thread,
  }));
}

export function applyReactionEvent(
  state: TimelineState,
  e: ReactionEvent
): TimelineState {
  const i = state.messages.findIndex((x) => x.id === e.messageId);
  if (i < 0) return state;
  const msg = state.messages[i];
  const at = msg.reactions.findIndex((r) => r.emoji === e.emoji);
  const cur = at >= 0 ? msg.reactions[at] : null;
  const has = cur?.userIds.includes(e.userId) ?? false;
  if ((e.type === 'add') === has) return state;
  const userIds =
    e.type === 'add'
      ? [...(cur?.userIds ?? []), e.userId]
      : (cur?.userIds ?? []).filter((u) => u !== e.userId);
  const summary = { emoji: e.emoji, count: userIds.length, userIds };
  const reactions =
    at < 0
      ? [...msg.reactions, summary]
      : userIds.length
        ? replaceAt(msg.reactions, at, summary)
        : msg.reactions.filter((_, j) => j !== at);
  return {
    ...state,
    messages: replaceAt(state.messages, i, { ...msg, reactions }),
  };
}

export interface DayGroup {
  /** YYYY-MM-DD in the time zone. */
  dayKey: string;
  kind: 'today' | 'yesterday' | 'date';
  messages: ChatMessage[];
}

const dayKeyIn = (ms: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));

/** Consecutive day groups (input oldest first) for "Today" / "Yesterday" / date dividers. */
export function groupByDay(
  messages: readonly ChatMessage[],
  timeZone: string,
  now: Date = new Date()
): DayGroup[] {
  const today = dayKeyIn(now.getTime(), timeZone);
  const [y, mo, d] = today.split('-').map(Number);
  const yesterday = new Date(Date.UTC(y, mo - 1, d - 1))
    .toISOString()
    .slice(0, 10);
  const groups: DayGroup[] = [];
  for (const m of messages) {
    const dayKey = dayKeyIn(timestampKey(m.createdAt) / 1000, timeZone);
    const last = groups[groups.length - 1];
    if (last && last.dayKey === dayKey) last.messages.push(m);
    else
      groups.push({
        dayKey,
        kind:
          dayKey === today
            ? 'today'
            : dayKey === yesterday
              ? 'yesterday'
              : 'date',
        messages: [m],
      });
  }
  return groups;
}

export const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** Compact row: same human author as the previous message, less than 5 minutes later. Apply within a day group. */
export function isGroupedWithPrevious(
  prev: ChatMessage | null | undefined,
  cur: ChatMessage
): boolean {
  if (!prev || prev.authorKind !== 'user' || cur.authorKind !== 'user')
    return false;
  if (!cur.authorId || prev.authorId !== cur.authorId) return false;
  const gap =
    (timestampKey(cur.createdAt) - timestampKey(prev.createdAt)) / 1000;
  return gap >= 0 && gap < GROUP_WINDOW_MS;
}
