/**
 * Which of a browser's tabs reports the person's presence, and what it
 * says. `touch_presence` keeps one row per person and the last write
 * wins, so a tab left hidden in the background used to write `away` over
 * the `online` of the tab being worked in, twice a minute.
 *
 * - One tab beats: the holder of a Web Lock. A tab that is shown takes it
 *   (`steal`), so a suspended background tab never holds the beat of
 *   someone at work; a tab that closes passes it on.
 * - Every tab tells the others when it was last used and whether it is on
 *   screen. The person is `online` while any tab is both shown and used.
 *
 * Without Web Locks every tab beats for itself.
 */
import {
  HEARTBEAT_MS,
  IDLE_AFTER_MS,
  OFFLINE_AFTER_MS,
  type StoredPresence,
} from './presence';

export interface TabState {
  visible: boolean;
  /** When the person last did something in it. */
  activeAt: number;
}

/** What one browser says of its person, from all its tabs. */
export function browserStatus(
  tabs: Iterable<TabState>,
  now: number
): StoredPresence {
  for (const tab of tabs) {
    if (tab.visible && now - tab.activeAt <= IDLE_AFTER_MS) return 'online';
  }
  return 'away';
}

interface TabMessage extends TabState {
  id: string;
}

export interface PresenceTabs {
  /** This tab's person did something. */
  active: () => void;
  /** This tab was shown, hidden or focused. */
  changed: () => void;
  /** This tab is closing (or going into the back/forward cache). */
  leave: () => void;
  stop: () => void;
}

type ChannelLike = Pick<
  BroadcastChannel,
  'postMessage' | 'close' | 'onmessage'
>;

export function startPresenceTabs(deps: {
  /** The lock and channel, shared by the tabs of one workspace. */
  name: string;
  id: string;
  locks: Pick<LockManager, 'request'> | null;
  channel: ChannelLike | null;
  isVisible: () => boolean;
  beat: (status: StoredPresence) => void;
}): PresenceTabs {
  const { name, id, locks, channel, isVisible } = deps;
  let stopped = false;
  let leading = !locks;
  let activeAt = Date.now();
  let lastSaid: StoredPresence | null = null;
  let release = () => {};
  let queued: AbortController | null = null;
  const peers = new Map<string, TabState & { heardAt: number }>();

  const status = (): StoredPresence => {
    const now = Date.now();
    for (const [peer, s] of peers) {
      // A crashed tab says no goodbye.
      if (now - s.heardAt > OFFLINE_AFTER_MS) peers.delete(peer);
    }
    return browserStatus(
      [{ visible: isVisible(), activeAt }, ...peers.values()],
      now
    );
  };
  const say = () => {
    if (stopped || !leading) return;
    lastSaid = status();
    deps.beat(lastSaid);
  };
  const tell = (visible = isVisible()) => {
    channel?.postMessage({ id, visible, activeAt } satisfies TabMessage);
  };

  const lead = (steal: boolean) => {
    if (!locks) return;
    queued?.abort();
    const mine = new AbortController();
    queued = mine;
    locks
      // `steal` and `signal` cannot be combined.
      .request(name, steal ? { steal } : { signal: mine.signal }, () => {
        if (stopped || queued !== mine) return;
        leading = true;
        say();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      })
      .catch((err: unknown) => {
        if (stopped || queued !== mine) return;
        // Taken by the tab being shown: wait for it to close. Any other
        // refusal would repeat, so this tab reports for itself.
        leading = (err as Error | null)?.name !== 'AbortError';
        if (!leading) lead(false);
      });
  };

  if (channel) {
    channel.onmessage = (e: MessageEvent) => {
      const { id: peer, ...state } = e.data as TabMessage;
      peers.set(peer, { ...state, heardAt: Date.now() });
      // Seen at once, not at the next beat. Only towards online: going
      // away is the interval's, so a switch between tabs says nothing.
      if (leading && lastSaid === 'away' && status() === 'online') say();
    };
  }

  lead(isVisible());
  if (!locks) say();
  tell();
  const timer = setInterval(() => {
    tell();
    say();
  }, HEARTBEAT_MS);

  return {
    active: () => {
      activeAt = Date.now();
      if (leading && lastSaid === 'away' && status() === 'online') say();
    },
    changed: () => {
      const visible = isVisible();
      if (visible) activeAt = Date.now();
      tell();
      if (visible && !leading) lead(true);
      else if (visible || !locks) say();
    },
    leave: () => tell(false),
    stop: () => {
      tell(false);
      stopped = true;
      clearInterval(timer);
      queued?.abort();
      release();
      channel?.close();
    },
  };
}
