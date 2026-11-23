import type { MessagePage, RoomMessage } from './reads';
import { mergeRoomMessages } from './view';

/**
 * What the group's timeline holds, with no hole in it: every message from
 * the oldest held to the newest read. Pure of React, so the rules below
 * are tested without a DOM.
 */

/** Pages read at most to reach what is held after a long gap. */
export const ROOM_CATCH_UP_PAGES = 5;

export interface RoomTimelineState {
  /** Null until a first page was read. */
  messages: RoomMessage[] | null;
  /** Where the page of older messages starts; null when there is none. */
  older: string | null;
  /** The last read failed. */
  failed: boolean;
}

export const ROOM_TIMELINE_EMPTY: RoomTimelineState = {
  messages: null,
  older: null,
  failed: false,
};

/** A failed first read must not look like a group without messages. */
export function timelinePhase(
  s: RoomTimelineState
): 'loading' | 'failed' | 'shown' {
  if (s.messages !== null) return 'shown';
  return s.failed ? 'failed' : 'loading';
}

export interface RoomTimeline {
  state: () => RoomTimelineState;
  /** Read the newest messages. False: the read failed. */
  refresh: () => Promise<boolean>;
  /** Read one page above. False: nothing was added. */
  loadOlder: () => Promise<boolean>;
}

export function createRoomTimeline(
  page: (before: string | null) => Promise<MessagePage>
): RoomTimeline {
  let state = ROOM_TIMELINE_EMPTY;
  let started = 0;
  let landed = 0;
  // Grows when the held messages are replaced: an older page asked for
  // before that no longer joins them.
  let replaced = 0;

  /** The newest page, and the ones back to what is held, up to the cap. */
  const readNewest = async () => {
    const held = new Set((state.messages ?? []).map((m) => m.id));
    const meets = (p: MessagePage) => p.messages.some((m) => held.has(m.id));
    let p = await page(null);
    let messages = p.messages;
    let joins = meets(p);
    for (
      let n = 1;
      n < ROOM_CATCH_UP_PAGES && held.size > 0 && !joins && p.nextBefore;
      n++
    ) {
      p = await page(p.nextBefore);
      messages = mergeRoomMessages(messages, p.messages);
      joins = meets(p);
    }
    return { messages, joins, older: p.nextBefore };
  };

  return {
    state: () => state,
    refresh: async () => {
      const mine = ++started;
      let read: Awaited<ReturnType<typeof readNewest>>;
      try {
        read = await readNewest();
      } catch {
        if (mine < landed) return true;
        state = { ...state, failed: true };
        return false;
      }
      // One asked for later has answered: this one is older than that.
      if (mine < landed) return true;
      landed = mine;
      if (read.joins) {
        state = {
          messages: mergeRoomMessages(state.messages ?? [], read.messages),
          older: state.older,
          failed: false,
        };
      } else {
        // The first page, or too much was missed to reach what is held:
        // keeping both would leave a hole no "load older" ever fills.
        replaced += 1;
        state = { messages: read.messages, older: read.older, failed: false };
      }
      return true;
    },
    loadOlder: async () => {
      const before = state.older;
      const then = replaced;
      if (!before) return false;
      let p: MessagePage;
      try {
        p = await page(before);
      } catch {
        // The button stays; the next scroll tries again.
        return false;
      }
      if (then !== replaced) return false;
      state = {
        ...state,
        messages: mergeRoomMessages(state.messages ?? [], p.messages),
        older: p.nextBefore,
      };
      return true;
    },
  };
}
