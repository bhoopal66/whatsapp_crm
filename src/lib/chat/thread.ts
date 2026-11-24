/**
 * An open thread: its root and its replies, read together and kept
 * right by the realtime events. Framework-free, so the rules are tested
 * here rather than discovered in the browser; `hooks/use-thread.ts` is
 * the React side.
 *
 * The root and the replies are two `timeline-cache` entries (the root a
 * main-list one, so replies bump its summary), for their journal: an
 * answer is merged into what is shown and the events since the read
 * began are replayed over it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  attachmentsFor,
  listMessages,
  MESSAGE_COLUMNS,
  reactionsFor,
  sharedCallCards,
  sharedCards,
  threadSummaries,
} from './api';
import { toChatError } from './errors';
import { compareMessages } from './message-list';
import {
  applyOlderPage,
  applyTimelineDetails,
  beginTimelineFetch,
  endTimelineFetch,
  placeholderTimeline,
  recordTimelineEvent,
  revalidateTimeline,
  timelineMark,
  type CachedTimeline,
  type DetailKind,
  type TimelineDetails,
  type TimelineEvent,
} from './timeline-cache';
import { createDetailLoader, type ReadDetail } from './timeline-details';
import { toChatMessage, type ChatMessage, type MessagePage } from './types';

/** Replies read at once; a longer thread opens on its latest ones. */
export const REPLY_LIMIT = 200;

/** How long after a failed catch-up read the thread tries once more. */
export const CATCH_UP_RETRY_MS = 4000;

export type ThreadDetails = TimelineDetails;
type Cursor = Pick<ChatMessage, 'createdAt' | 'id'>;

export interface ThreadView {
  root: CachedTimeline;
  replies: CachedTimeline;
  /** `failed`: the first read failed and there is nothing to show. */
  phase: 'loading' | 'ready' | 'failed';
  loadingOlder: boolean;
}

/** The reads a thread makes. */
export interface ThreadReads {
  root(): Promise<ChatMessage | null>;
  /** The newest page, or the one before `before`. */
  page(before?: Cursor): Promise<MessagePage>;
  /** Summaries and cards are the root's only. With `only`, that kind. */
  details(
    ids: string[],
    rootIds: string[],
    only?: DetailKind
  ): Promise<ThreadDetails>;
}

export function threadReads(
  sb: SupabaseClient,
  channelId: string,
  rootId: string
): ThreadReads {
  return {
    async root() {
      const { data, error } = await sb
        .from('internal_messages')
        .select(MESSAGE_COLUMNS)
        .eq('id', rootId)
        .maybeSingle();
      if (error) throw toChatError(error);
      return data ? toChatMessage(data as Record<string, unknown>) : null;
    },
    page: (before) =>
      listMessages(sb, channelId, {
        threadRootId: rootId,
        limit: REPLY_LIMIT,
        before: before && { createdAt: before.createdAt, id: before.id },
      }),
    async details(ids, rootIds, only) {
      const asked = (kind: DetailKind) => !only || only === kind;
      // The ids go in the URL: no more of them at once than a page.
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += REPLY_LIMIT)
        chunks.push(ids.slice(i, i + REPLY_LIMIT));
      const [attachments, reactions, threads, cards, callCards] =
        await Promise.all([
          asked('attachments')
            ? Promise.all(chunks.map((c) => attachmentsFor(sb, c)))
            : [],
          asked('reactions')
            ? Promise.all(chunks.map((c) => reactionsFor(sb, c)))
            : [],
          threadSummaries(sb, rootIds),
          sharedCards(sb, rootIds),
          sharedCallCards(sb, rootIds),
        ]);
      return {
        attachments: Object.assign({}, ...attachments),
        reactions: Object.assign({}, ...reactions),
        threads,
        cards,
        callCards,
      };
    },
  };
}

export function openThread(channelId: string, rootId: string): ThreadView {
  return {
    root: placeholderTimeline(channelId),
    replies: placeholderTimeline(channelId, rootId),
    phase: 'loading',
    loadingOlder: false,
  };
}

/** The two marks of one read: its rows, and their details. */
interface Marks {
  rows: number;
  details: number;
}

const openMarks = (): Marks => ({
  rows: timelineMark(),
  details: timelineMark(),
});
const begin = (e: CachedTimeline, m: Marks) =>
  beginTimelineFetch(beginTimelineFetch(e, m.rows), m.details);
const end = (e: CachedTimeline, m: Marks) =>
  endTimelineFetch(endTimelineFetch(e, m.rows), m.details);

/**
 * The newest replies, as far back as the ones held: a reply edited or
 * removed while events were missed may be on any page that was loaded.
 * At most one page more than is held; past that the window starts over.
 */
export async function readReplies(
  page: ThreadReads['page'],
  held: readonly ChatMessage[]
): Promise<MessagePage> {
  const most = Math.ceil(held.length / REPLY_LIMIT) + 1;
  let out = await page();
  for (let read = 1; read < most && out.hasMore && held.length > 0; read++) {
    if (compareMessages(out.messages[0], held[0]) <= 0) break;
    const older = await page(out.messages[0]);
    out = {
      messages: [...older.messages, ...out.messages],
      hasMore: older.hasMore,
    };
  }
  return out;
}

/** `page` without what is older than the replies shown, so a re-read does not grow the window. */
function withinHeld(entry: CachedTimeline, page: MessagePage): MessagePage {
  const oldest = entry.timeline.messages[0];
  if (!entry.loaded || !entry.timeline.hasMoreOlder || !oldest) return page;
  const messages = page.messages.filter((m) => compareMessages(m, oldest) >= 0);
  return {
    messages,
    hasMore: page.hasMore || messages.length < page.messages.length,
  };
}

/**
 * A read of the whole thread merged into what is shown: its rows win
 * (an edit, a removal), a reply that arrived during the read is kept,
 * and so is an older page loaded meanwhile.
 */
export function mergeThread(
  view: ThreadView,
  root: ChatMessage | null,
  page: MessagePage,
  details: ThreadDetails,
  marks: Marks
): ThreadView {
  const { channelId } = view.replies.timeline;
  const now = Date.now();
  const rootRows = root ? [root] : [];
  const rootEntry = revalidateTimeline(
    view.root,
    channelId,
    { messages: rootRows, hasMore: false },
    now,
    marks.rows
  );
  const replies = revalidateTimeline(
    view.replies,
    channelId,
    withinHeld(view.replies, page),
    now,
    marks.rows,
    { keepOlder: view.replies.loaded }
  );
  const next = {
    ...view,
    root: applyTimelineDetails(
      // The answer is every card the root has.
      { ...rootEntry, cards: {}, callCards: {} },
      rootRows.map((m) => m.id),
      details,
      marks.details
    ),
    replies: applyTimelineDetails(
      replies,
      page.messages.map((m) => m.id),
      details,
      marks.details
    ),
  };
  const loaded = next.root.loaded && next.replies.loaded;
  return { ...next, phase: loaded ? 'ready' : 'failed' };
}

/**
 * An older page below the replies shown, unless they no longer start at
 * `cursor`: a re-read started the window over, and the page would leave
 * a gap above it.
 */
export function mergeOlderReplies(
  entry: CachedTimeline,
  cursor: Cursor,
  page: MessagePage,
  details: ThreadDetails,
  marks: Marks
): CachedTimeline {
  if (entry.timeline.messages[0]?.id !== cursor.id) return end(entry, marks);
  return applyTimelineDetails(
    applyOlderPage(entry, page, marks.rows),
    page.messages.map((m) => m.id),
    details,
    marks.details
  );
}

/** A realtime event written into the thread; another message's is ignored. */
export function recordThreadEvent(
  view: ThreadView,
  event: TimelineEvent
): ThreadView {
  const rootId = view.replies.timeline.threadRootId;
  if (event.kind === 'message' && event.event.type !== 'delete') {
    const { id, threadRootId } = event.event.message;
    if (id !== rootId && threadRootId !== rootId) return view;
  }
  const root = recordTimelineEvent(view.root, event);
  const replies = recordTimelineEvent(view.replies, event);
  return root === view.root && replies === view.replies
    ? view
    : { ...view, root, replies };
}

export type ThreadStore = ReturnType<typeof createThreadStore>;

/**
 * One thread's state and its reads. A store is one thread's for good, so
 * a slow answer can only ever land in the thread it was asked for.
 */
export function createThreadStore(
  reads: ThreadReads,
  channelId: string,
  rootId: string
) {
  let view = openThread(channelId, rootId);
  const listeners = new Set<() => void>();
  /** Set while the thread is on screen. */
  let shown: {
    fail: (err: unknown) => unknown;
    pending: number;
    landed: number;
    /** The latest read that failed quietly, and its one retry. */
    missed: number;
    again?: ReturnType<typeof setTimeout>;
  } | null = null;

  const set = (next: ThreadView) => {
    if (next === view) return;
    view = next;
    listeners.forEach((fn) => fn());
  };
  const patchReplies = (fn: (e: CachedTimeline) => CachedTimeline) =>
    set({ ...view, replies: fn(view.replies) });
  const patchBoth = (fn: (e: CachedTimeline) => CachedTimeline) =>
    set({ ...view, root: fn(view.root), replies: fn(view.replies) });

  /** What a row event does not carry: a new reply's files and reactions. */
  const replyDetails = createDetailLoader({
    read: (async (kind, ids) =>
      (await reads.details(ids, [], kind))[kind]) as ReadDetail,
    get: () => view.replies,
    patch: patchReplies,
    kinds: ['attachments', 'reactions'],
  });
  const fillIn = replyDetails.load;

  /** A failed catch-up read, once more, unless one begun after it has landed. */
  function readAgain(me: NonNullable<typeof shown>, mark: number) {
    me.missed = Math.max(me.missed, mark);
    clearTimeout(me.again);
    me.again = setTimeout(() => {
      if (me !== shown || view.phase !== 'ready') return;
      if (me.landed < me.missed) void load(true);
    }, CATCH_UP_RETRY_MS);
  }

  /**
   * The whole thread, again. Once it shows, a failure is quiet and tried
   * once more. False when it is still to be read: the read failed, and
   * none begun after it has landed.
   */
  async function load(retry = false): Promise<boolean> {
    const me = shown;
    if (!me) return true;
    const marks = openMarks();
    patchBoth((e) => begin(e, marks));
    me.pending += 1;
    try {
      const held = view.replies.loaded ? view.replies.timeline.messages : [];
      const [root, page] = await Promise.all([
        reads.root(),
        readReplies(reads.page, held),
      ]);
      const rootIds = root ? [root.id] : [];
      const read = page.messages.map((m) => m.id);
      const details = await reads.details([...rootIds, ...read], rootIds);
      // Left meanwhile, or a read begun after this one has landed.
      if (me !== shown || marks.rows < me.landed) {
        patchBoth((e) => end(e, marks));
        return true;
      }
      me.landed = marks.rows;
      set(mergeThread(view, root, page, details, marks));
      // A reply the replay brought has its row only.
      const known = new Set([...read, ...held.map((m) => m.id)]);
      const { messages } = view.replies.timeline;
      void fillIn(messages.map((m) => m.id).filter((id) => !known.has(id)));
      return true;
    } catch (err) {
      patchBoth((e) => end(e, marks));
      if (me !== shown || marks.rows < me.landed) return true;
      // Another read under way may still show it.
      if (view.phase !== 'loading' || me.pending > 1) {
        if (!retry) readAgain(me, marks.rows);
        return false;
      }
      set({ ...view, phase: 'failed' });
      me.fail(err);
      return false;
    } finally {
      me.pending -= 1;
    }
  }

  return {
    get: () => view,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    /** On screen until the returned stop is called. */
    show(fail: (err: unknown) => unknown) {
      const me: NonNullable<typeof shown> = {
        fail,
        pending: 0,
        landed: 0,
        missed: 0,
      };
      shown = me;
      const stopDetails = replyDetails.show();
      void load();
      return () => {
        stopDetails();
        if (shown === me) shown = null;
        clearTimeout(me.again);
      };
    },
    /** Events were missed. False when the read failed. */
    resync: () => load(),
    /** Read the replies' missing files (`missingFiles`) again. */
    retryFiles: () => replyDetails.retry(),
    /** Try again, after a failed first read. */
    retry() {
      set({ ...view, phase: 'loading' });
      void load();
    },
    record(event: TimelineEvent) {
      set(recordThreadEvent(view, event));
      if (event.kind !== 'message' || event.event.type !== 'insert') return;
      const m = event.event.message;
      if (m.threadRootId === rootId) void fillIn([m.id]);
    },
    async loadOlder() {
      const me = shown;
      const { messages, hasMoreOlder } = view.replies.timeline;
      const cursor = messages[0];
      if (!me || !cursor || !hasMoreOlder || view.loadingOlder) return;
      const marks = openMarks();
      set({
        ...view,
        loadingOlder: true,
        replies: begin(view.replies, marks),
      });
      try {
        const page = await reads.page(cursor);
        const ids = page.messages.map((m) => m.id);
        const details = await reads.details(ids, []);
        patchReplies((e) => mergeOlderReplies(e, cursor, page, details, marks));
      } catch (err) {
        patchReplies((e) => end(e, marks));
        if (me === shown) me.fail(err);
      } finally {
        set({ ...view, loadingOlder: false });
      }
    },
  };
}
