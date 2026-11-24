import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HEARTBEAT_MS, IDLE_AFTER_MS, OFFLINE_AFTER_MS } from './presence';
import { browserStatus, startPresenceTabs } from './presence-tabs';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

/** One browser: a Web Lock with `steal`, and a channel to every other tab. */
function browser() {
  type Waiter = { run: () => void };
  let holder: { abort: () => void } | null = null;
  const queue: Waiter[] = [];
  const channels = new Set<{ onmessage: ((e: MessageEvent) => void) | null }>();
  const next = () => {
    holder = null;
    queue.shift()?.run();
  };
  const request = (
    _name: string,
    options: LockOptions,
    callback: () => unknown
  ) =>
    new Promise<void>((resolve, reject) => {
      const take = () => {
        const me = {
          abort: () =>
            reject(Object.assign(new Error('stolen'), { name: 'AbortError' })),
        };
        holder = me;
        void Promise.resolve(callback()).then(() => {
          resolve();
          if (holder === me) next();
        });
      };
      if (options.steal) {
        holder?.abort();
        take();
      } else if (!holder) take();
      else {
        const waiter = { run: take };
        queue.push(waiter);
        options.signal?.addEventListener('abort', () => {
          if (queue.includes(waiter)) queue.splice(queue.indexOf(waiter), 1);
          reject(Object.assign(new Error('gone'), { name: 'AbortError' }));
        });
      }
    });
  const said: string[] = [];
  let n = 0;
  return {
    said,
    open(visible: boolean, withLocks = true) {
      const id = `t${++n}`;
      const tab = { visible };
      const channel = {
        onmessage: null as ((e: MessageEvent) => void) | null,
        postMessage: (data: unknown) => {
          for (const c of channels) {
            if (c !== channel) c.onmessage?.({ data } as MessageEvent);
          }
        },
        close: () => void channels.delete(channel),
      };
      channels.add(channel);
      const tabs = startPresenceTabs({
        name: 'p',
        id,
        locks: withLocks
          ? ({ request } as unknown as Pick<LockManager, 'request'>)
          : null,
        channel: withLocks ? channel : null,
        isVisible: () => tab.visible,
        beat: (status) => said.push(`${id}:${status}`),
      });
      return {
        ...tabs,
        show(v: boolean) {
          tab.visible = v;
          tabs.changed();
        },
      };
    },
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

describe('browserStatus', () => {
  it('is online only while some tab is both shown and used', () => {
    const now = 10 * IDLE_AFTER_MS;
    const used = now - 1_000;
    const idle = now - IDLE_AFTER_MS - 1;
    expect(browserStatus([{ visible: true, activeAt: used }], now)).toBe(
      'online'
    );
    expect(
      browserStatus(
        [
          { visible: false, activeAt: used },
          { visible: true, activeAt: idle },
        ],
        now
      )
    ).toBe('away');
  });
});

describe('startPresenceTabs', () => {
  it('a hidden tab never writes away over the tab being worked in', async () => {
    const b = browser();
    b.open(true).show(false);
    const worked = b.open(true);
    await settle();
    b.said.length = 0;
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      worked.active();
    }
    expect(b.said).toEqual(Array(4).fill('t2:online'));
  });

  it('switching tabs never says away', async () => {
    const b = browser();
    const one = b.open(true);
    const two = b.open(false);
    await settle();
    one.show(false);
    two.show(true);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(b.said.filter((s) => s.endsWith('away'))).toEqual([]);
    expect(b.said.at(-1)).toBe('t2:online');
  });

  it('one browser beats once, and says away when no tab is shown', async () => {
    const b = browser();
    const one = b.open(true);
    b.open(false);
    await settle();
    one.show(false);
    b.said.length = 0;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(b.said).toEqual(['t1:away']);
  });

  it('a second window in use keeps an idle one online', async () => {
    const b = browser();
    const second = b.open(true);
    b.open(true); // leads, then sits idle
    await settle();
    await vi.advanceTimersByTimeAsync(IDLE_AFTER_MS + HEARTBEAT_MS);
    expect(b.said.at(-1)).toBe('t2:away');
    second.active();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(b.said.at(-1)).toBe('t2:online');
  });

  it('a closed tab passes the beat on, and a crashed one is forgotten', async () => {
    const b = browser();
    b.open(false);
    const shown = b.open(true);
    await settle();
    shown.stop();
    await settle();
    expect(b.said.at(-1)).toBe('t1:away');
    expect(OFFLINE_AFTER_MS).toBeGreaterThan(HEARTBEAT_MS);
  });

  it('without Web Locks every tab reports for itself, as before', () => {
    const b = browser();
    const one = b.open(true, false);
    b.open(false, false);
    one.show(false);
    expect(b.said).toEqual(['t1:online', 't2:away', 't1:away']);
  });
});

it('the heartbeat goes through the tabs', () => {
  const src = readFileSync('src/components/presence/presence-heartbeat.tsx', {
    encoding: 'utf8',
  });
  expect(src).toContain('startPresenceTabs(');
  expect(src).not.toContain('setInterval(');
});
