import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPushNavigator } from './navigate';

const ORIGIN = 'https://crm.example';

/** Delivers at once. */
class FakeChannel {
  port1 = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    close: () => {},
  };
  port2 = {
    postMessage: (data: unknown) => this.port1.onmessage?.({ data }),
  };
}

type Post = (data: { type: string; url: string }, ports: unknown[]) => void;

function tab(
  path: string,
  onMessage: Post = () => {},
  over: Record<string, unknown> = {}
) {
  const client = {
    url: ORIGIN + path,
    focused: false,
    visibilityState: 'hidden',
    posted: [] as string[],
    focus: vi.fn(async () => client),
    navigate: vi.fn(async () => client),
    postMessage(data: { type: string; url: string }, ports: unknown[]) {
      client.posted.push(data.type);
      onMessage(data, ports);
    },
    ...over,
  };
  return client;
}

/** The page before 2026-11-25: follows 'push:navigate', never answers. */
const olderPage =
  (go: (url: string) => void): Post =>
  (data) => {
    if (data.type === 'push:navigate') go(data.url);
  };
const newPage = (go: (url: string) => void): Post => {
  const navigate = createPushNavigator(go);
  return (data, ports) => navigate({ data, ports: ports as MessagePort[] });
};

let openWindow: ReturnType<typeof vi.fn>;

async function click(
  tabs: ReturnType<typeof tab>[],
  url = '/inbox?c=1',
  ms = 20_000
) {
  const handlers: Record<string, (e: unknown) => void> = {};
  openWindow = vi.fn(async () => null);
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (name: string, fn: (e: unknown) => void) => {
      handlers[name] = fn;
    },
    clients: { matchAll: async () => tabs, openWindow },
  };
  runInNewContext(readFileSync('public/sw.js', 'utf8'), {
    self,
    URL,
    MessageChannel: FakeChannel,
    setTimeout,
    clearTimeout,
  });
  let work: Promise<unknown> = Promise.resolve();
  handlers.notificationclick({
    notification: { close: () => {}, data: { url } },
    waitUntil: (p: Promise<unknown>) => {
      work = p;
    },
  });
  await vi.advanceTimersByTimeAsync(ms);
  // Cut short, the click is still waiting.
  if (ms === 20_000) await work;
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe('a notification click', () => {
  it('is followed by the open page itself, without a load', async () => {
    const go = vi.fn();
    const t = tab('/inbox', newPage(go));
    await click([t], '/meetings/m1');
    expect(t.focus).toHaveBeenCalled();
    expect(go.mock.calls).toEqual([['/meetings/m1']]);
    expect(t.navigate).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('moves a page of an older build once and never loads it', async () => {
    const go = vi.fn();
    const t = tab('/inbox', olderPage(go));
    await click([t]);
    expect(go.mock.calls).toEqual([['/inbox?c=1']]);
    expect(t.navigate).not.toHaveBeenCalled();
  });

  it('is told again to a page still starting up, which goes once', async () => {
    const go = vi.fn();
    const page = newPage(go);
    let ready = false;
    const t = tab('/inbox', (d, p) => void (ready && page(d, p)));
    setTimeout(() => {
      ready = true;
    }, 1000);
    await click([t]);
    expect(go).toHaveBeenCalledTimes(1);
    expect(t.navigate).not.toHaveBeenCalled();
  });

  it.each(['/login?next=%2Finbox', '/join/abc', '/f/abc', '/'])(
    'loads %s, where nothing listens, after 700 ms',
    async (path) => {
      const t = tab(path);
      await click([t], '/calls', 600);
      expect(t.navigate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(t.navigate).toHaveBeenCalledWith('/calls');
    }
  );

  it('never both moves and loads an older page whose url is out of date', async () => {
    const go = vi.fn();
    const t = tab('/login', olderPage(go));
    await click([t]);
    expect(go.mock.calls.length + t.navigate.mock.calls.length).toBe(1);
  });

  it('prefers the app tab in front, and any app tab to a sign-in page', async () => {
    const go = vi.fn();
    const back = tab('/inbox', newPage(vi.fn()));
    const front = tab('/contacts', newPage(go), {
      focused: true,
      visibilityState: 'visible',
    });
    await click([back, front]);
    expect(front.focus).toHaveBeenCalled();
    expect(back.focus).not.toHaveBeenCalled();
    expect(go).toHaveBeenCalledTimes(1);

    const login = tab('/login', undefined, {
      focused: true,
      visibilityState: 'visible',
    });
    await click([login, back]);
    expect(back.focus).toHaveBeenCalled();
    expect(login.focus).not.toHaveBeenCalled();
  });

  it('opens a window when there is no tab', async () => {
    await click([]);
    expect(openWindow).toHaveBeenCalledWith('/inbox?c=1');
  });

  it('still reaches a tab that cannot be focused', async () => {
    const go = vi.fn();
    const t = tab('/inbox', newPage(go), {
      focus: async () => {
        throw new Error('not allowed');
      },
    });
    await click([t]);
    expect(go).toHaveBeenCalledTimes(1);
  });
});

describe('OUTSIDE_PATHS', () => {
  it('lists every page outside the dashboard shell', () => {
    const declared = readFileSync('public/sw.js', 'utf8').match(
      /OUTSIDE_PATHS = \[([^\]]*)\]/
    )![1];
    const listed = [...declared.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const hasPage = (dir: string): boolean =>
      existsSync(`${dir}/page.tsx`) ||
      readdirSync(dir, { withFileTypes: true }).some(
        (d) => d.isDirectory() && hasPage(`${dir}/${d.name}`)
      );
    const under = (dir: string) =>
      readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && hasPage(`${dir}/${d.name}`))
        .map((d) => d.name);
    const outside = under('src/app')
      .filter((n) => n !== '(dashboard)')
      .flatMap((n) => (n.startsWith('(') ? under(`src/app/${n}`) : [n]));
    expect(listed.sort()).toEqual(outside.map((n) => `/${n}`).sort());
  });
});

describe('the page', () => {
  it('follows only its own messages, to a path of this app', () => {
    const go = vi.fn();
    const navigate = createPushNavigator(go);
    for (const data of [
      null,
      { type: 'other', url: '/inbox' },
      { type: 'push:navigate', url: 'https://evil.example' },
      { type: 'push:navigate', url: '//evil.example' },
      { type: 'push:open', url: '/\\evil.example' },
    ])
      navigate({ data, ports: [] });
    expect(go).not.toHaveBeenCalled();
    // A worker of the build before sends no id and no port.
    navigate({ data: { type: 'push:navigate', url: '/a' }, ports: [] });
    navigate({ data: { type: 'push:navigate', url: '/a' }, ports: [] });
    expect(go).toHaveBeenCalledTimes(2);
  });
});
