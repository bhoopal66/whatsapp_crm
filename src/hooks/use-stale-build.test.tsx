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
let fields: unknown[];
let held: Map<string, string>;

const chunkError = () =>
  Object.assign(new Error('Failed to load chunk /a.js from module 1'), {
    name: 'ChunkLoadError',
  });

beforeEach(() => {
  reload.mockClear();
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

const show = (
  Screen: typeof DashboardError,
  error: Error = chunkError()
): string =>
  renderToStaticMarkup(<Screen error={error} unstable_retry={() => {}} />);

describe.each([
  ['dashboard', DashboardError],
  ['root', RootError],
])('the %s error screen', (_name, Screen) => {
  it('reloads an old tab by itself, once', () => {
    expect(show(Screen)).toContain('update.reload');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(show(Screen)).toContain('update.title');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps the retry for any other error', () => {
    expect(show(Screen, new TypeError('x'))).toContain('retry');
    expect(reload).not.toHaveBeenCalled();
  });

  it('waits for the person while something is typed', () => {
    fields = [{ tagName: 'TEXTAREA', value: 'Dear', closest: () => null }];
    expect(show(Screen)).toContain('update.reload');
    expect(reload).not.toHaveBeenCalled();
  });

  it('waits while a call or meeting is on', () => {
    const over = holdRingSilent();
    show(Screen);
    expect(reload).not.toHaveBeenCalled();
    over();
    show(Screen);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('waits while a note is parked for another chat', () => {
    noteDrafts.write('u1', 'c1', { text: 'half', picked: [] });
    show(Screen);
    expect(reload).not.toHaveBeenCalled();
    noteDrafts.clear('u1', 'c1');
  });

  it('never reloads offline', () => {
    vi.stubGlobal('navigator', { onLine: false });
    show(Screen);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('the global error screen', () => {
  it('reloads an old tab, and says so in its own words', () => {
    expect(show(GlobalError)).toContain('A new version is available');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
