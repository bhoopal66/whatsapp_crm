/**
 * What is known about the open chat's history. An empty `messages` says
 * nothing until a read of that chat has succeeded: after a failed one it
 * is not "No messages yet", and nothing may be concluded from it (the
 * new-chat reminder, the outreach warnings).
 */
export interface ThreadLoad {
  conversationId: string | null;
  /** A read of it has succeeded (or its cached page was shown). */
  known: boolean;
  /** The last read failed. */
  failed: boolean;
}

export const NO_THREAD: ThreadLoad = {
  conversationId: null,
  known: false,
  failed: false,
};

/** A read starts; `cached` when an earlier read's page is on screen. */
export function loadStarted(
  prev: ThreadLoad,
  conversationId: string,
  cached: boolean
): ThreadLoad {
  return {
    conversationId,
    known: cached || isKnown(prev, conversationId),
    failed: false,
  };
}

export function loadSucceeded(conversationId: string): ThreadLoad {
  return { conversationId, known: true, failed: false };
}

/** A late failure of a chat already left changes nothing. */
export function loadFailed(
  prev: ThreadLoad,
  conversationId: string
): ThreadLoad {
  if (prev.conversationId !== conversationId) return prev;
  return { ...prev, failed: true };
}

export function isKnown(
  load: ThreadLoad,
  conversationId: string | null | undefined
): boolean {
  return load.known && load.conversationId === conversationId;
}

export function isFailed(
  load: ThreadLoad,
  conversationId: string | null | undefined
): boolean {
  return load.failed && load.conversationId === conversationId;
}

export type ThreadView = 'loading' | 'error' | 'empty' | 'messages';

/** What the messages area shows. */
export function threadView(
  load: ThreadLoad,
  conversationId: string | null | undefined,
  { loading, hasContent }: { loading: boolean; hasContent: boolean }
): ThreadView {
  if (loading) return 'loading';
  if (hasContent) return 'messages';
  if (isFailed(load, conversationId)) return 'error';
  return isKnown(load, conversationId) ? 'empty' : 'loading';
}

/**
 * Run a read, and once more when it failed. Null when both did, or when
 * `stillWanted` says nobody waits for it any more.
 */
export async function readTwice<T>(
  read: () => PromiseLike<{ data: T | null; error: unknown }>,
  stillWanted: () => boolean,
  pauseMs = 1500
): Promise<{ data: T | null } | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, pauseMs));
    if (!stillWanted()) return null;
    let error: unknown;
    try {
      const answer = await read();
      if (!answer.error) return { data: answer.data };
      error = answer.error;
    } catch (thrown) {
      error = thrown;
    }
    console.error('Failed to resync messages:', error);
  }
  return null;
}
