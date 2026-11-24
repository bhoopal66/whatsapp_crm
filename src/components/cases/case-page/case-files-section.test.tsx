import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('next-intl', () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => 'en',
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from 'sonner';

import { findElements, render, resetHooks, settle } from '@/test/hook-renderer';

import { CaseFilesSection, openDownload } from './case-files-section';
import { TabStatus } from './tab-kit';

const FILES = { specs: [], files: [], ready: false };
const json = (status: number, body: unknown) => ({
  ok: status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  resetHooks();
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe('the assembled case file', () => {
  const section = () =>
    CaseFilesSection({
      caseId: 'c-1',
      contactId: null,
      closed: false,
      labelOf: (k) => k,
      onChanged: () => {},
    });

  async function open(build: () => ReturnType<typeof json>) {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/build') ? build() : json(200, FILES)
    );
    vi.stubGlobal('fetch', fetchMock);
    render(section);
    await settle();
    return fetchMock;
  }
  const status = () =>
    findElements(render(section), (el) => el.type === TabStatus)[0];

  it('a failed read says so, and Retry reads it again', async () => {
    let answer = json(500, null);
    const fetchMock = await open(() => answer);
    expect(status().props).toMatchObject({
      failed: true,
      error: 'buildLoadFailed',
    });
    answer = json(200, { build: null });
    const before = fetchMock.mock.calls.length;
    (status().props.onRetry as () => void)();
    await settle();
    expect(fetchMock.mock.calls.slice(before)).toEqual([
      ['/api/cases/c-1/build', { cache: 'no-store' }],
    ]);
    expect(status()).toBeUndefined();
  });

  it('says nothing when there is none', async () => {
    await open(() => json(200, { build: null }));
    expect(status()).toBeUndefined();
  });
});

describe('openDownload', () => {
  const t = (k: string) => k;
  function tabOf() {
    const tab = {
      opener: {} as unknown,
      close: vi.fn(),
      location: { replace: vi.fn() },
    };
    const open = vi.fn((): typeof tab | null => tab);
    vi.stubGlobal('window', { open });
    return { tab, open };
  }

  it('opens the tab on the click, then sends it to the link', async () => {
    const { tab, open } = tabOf();
    const fetchMock = vi.fn(async () => json(200, { url: 'https://s/x.pdf' }));
    vi.stubGlobal('fetch', fetchMock);
    const done = openDownload('/api/x', t);
    expect(open).toHaveBeenCalledTimes(1);
    expect(tab.opener).toBeNull();
    await done;
    expect(tab.location.replace).toHaveBeenCalledWith('https://s/x.pdf');
    expect(tab.close).not.toHaveBeenCalled();
  });

  it('a refusal closes the tab and says so', async () => {
    const { tab } = tabOf();
    vi.stubGlobal('fetch', async () => json(409, { code: 'BUILD_STALE' }));
    await openDownload('/api/x', t);
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('a blocked tab says so and asks for no link', async () => {
    const { open } = tabOf();
    open.mockReturnValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await openDownload('/api/x', t);
    expect(toast.error).toHaveBeenCalledWith('downloadBlocked');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
