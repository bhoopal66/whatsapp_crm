import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No DOM here, so an effect runs at once (as in use-cases-overdue.test).
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (effect: () => void) => void effect(),
}));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/browser-reports/send', () => ({ reportClientError: () => {} }));

import DashboardError from '@/app/(dashboard)/error';
import RootError from '@/app/error';
import GlobalError from '@/app/global-error';
import { holdRingSilent } from '@/components/meetings/invite-ring-tone';
import { noteDrafts } from '@/lib/inbox/note-drafts';

const reload = vi.fn();
const healthz = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const answering = async () => Response.json({ ok: true });
let fields: unknown[];
let held: Map<string, string>;

const chunkError = () =>
  Object.assign(new Error('Failed to load chunk /a.js from module 1'), {
    name: 'ChunkLoadError',
  });

beforeEach(() => {
  reload.mockClear();
  healthz.mockReset().mockImplementation(answering);
  vi.stubGlobal('fetch', healthz);
  fields = [];
  held = new Map();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('document', {
    cookie: '',
    documentElement: { dataset: {} },
    querySelectorAll: () => fields,
  });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('window', {
    location: { reload },
    sessionStorage: {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => void held.set(k, v),
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Renders the screen, and lets its question to the server come back. */
const show = async (
  Screen: typeof DashboardError,
  error: Error = chunkError()
): Promise<string> => {
  const html = renderToStaticMarkup(
    <Screen error={error} unstable_retry={() => {}} />
  );
  await settled();
  return html;
};

describe.each([
  ['dashboard', DashboardError],
  ['root', RootError],
])('the %s error screen', (_name, Screen) => {
  it('reloads an old tab by itself, once', async () => {
    expect(await show(Screen)).toContain('update.reload');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(await show(Screen)).toContain('update.title');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps the retry for any other error', async () => {
    expect(await show(Screen, new TypeError('x'))).toContain('retry');
    expect(reload).not.toHaveBeenCalled();
  });

  it('waits for the person while something is typed', async () => {
    fields = [{ tagName: 'TEXTAREA', value: 'Dear', closest: () => null }];
    expect(await show(Screen)).toContain('update.reload');
    expect(reload).not.toHaveBeenCalled();
  });

  it('waits while a call or meeting is on', async () => {
    const over = holdRingSilent();
    await show(Screen);
    expect(reload).not.toHaveBeenCalled();
    over();
    await show(Screen);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('waits while a note is parked for another chat', async () => {
    noteDrafts.write('u1', 'c1', { text: 'half', picked: [] });
    await show(Screen);
    expect(reload).not.toHaveBeenCalled();
    noteDrafts.clear('u1', 'c1');
  });

  it.each<[string, typeof answering]>([
    ['is restarting', async () => new Response('', { status: 502 })],
    ['cannot be reached', () => Promise.reject(new TypeError('x'))],
    [
      "is behind someone else's page",
      async () => new Response('<html></html>', { status: 200 }),
    ],
  ])('leaves the button while the server %s', async (_what, answer) => {
    healthz.mockImplementation(answer);
    expect(await show(Screen)).toContain('update.reload');
    expect(reload).not.toHaveBeenCalled();
    // The tab still has its one reload.
    healthz.mockImplementation(answering);
    await show(Screen);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(healthz).toHaveBeenCalledWith(
      '/api/healthz',
      expect.objectContaining({
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      })
    );
  });

  it.each([
    [
      'typing',
      () => {
        fields = [{ tagName: 'TEXTAREA', value: 'Dear', closest: () => null }];
        return () => {};
      },
    ],
    ['a call', () => holdRingSilent()],
  ])('does not reload over %s begun while it asked', async (_what, begin) => {
    let answer: (res: Response) => void = () => {};
    healthz.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await show(Screen);
    const over = begin();
    answer(await answering());
    await settled();
    expect(reload).not.toHaveBeenCalled();
    over();
  });

  it('never reloads offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    await show(Screen);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('the global error screen', () => {
  it('reloads an old tab, and says so in its own words', async () => {
    expect(await show(GlobalError)).toContain('A new version is available');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
