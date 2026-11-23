import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

// A settings screen whose load failed must show an error with Retry and
// nothing that can be saved: the defaults would replace what is stored.
vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('next-intl', () => {
  const t = Object.assign((k: string) => k, { rich: (k: string) => k });
  return { useTranslations: () => t };
});
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'acc-1' }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ErrorState } from '@/components/dashboard/error-state';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { findElements, render, resetHooks, settle } from '@/test/hook-renderer';
import { ChatAssignmentPanel } from './chat-assignment-panel';
import { ResponseTimesPanel } from './response-times-panel';

const errors = (tree: ReactNode) =>
  findElements(tree, (el) => el.type === ErrorState);
const editable = (tree: ReactNode) =>
  findElements(tree, (el) => el.type === Switch || el.type === Button);
const retry = (tree: ReactNode) =>
  (errors(tree)[0].props.onRetry as () => void)();

beforeEach(() => {
  resetHooks();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const FAILURES: [string, () => Promise<unknown>][] = [
  ['offline', () => Promise.reject(new Error('offline'))],
  [
    'a server error',
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
  ],
  [
    'an answer without settings',
    async () => ({ ok: true, status: 200, json: async () => ({}) }),
  ],
  [
    'an answer that is not JSON',
    async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('<html>');
      },
    }),
  ],
];

const PANELS: [string, () => ReactNode, object][] = [
  [
    'ResponseTimesPanel',
    ResponseTimesPanel,
    { enabled: true, timezone: 'Asia/Dubai', hours: {}, targetMinutes: 42 },
  ],
  ['ChatAssignmentPanel', ChatAssignmentPanel, { defaultChatLimit: 42 }],
];

describe.each(PANELS)('%s', (_name, Panel, stored) => {
  it.each(FAILURES)('%s: an error with Retry, no form', async (_n, f) => {
    vi.stubGlobal('fetch', vi.fn(f));
    render(Panel);
    await settle();
    const tree = render(Panel);
    expect(errors(tree)).toHaveLength(1);
    expect(editable(tree)).toHaveLength(0);
  });

  it('Retry reads again and shows what is stored', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ settings: stored, members: [], available: true }),
      });
    vi.stubGlobal('fetch', fetchMock);
    render(Panel);
    await settle();
    retry(render(Panel));
    expect(errors(render(Panel))).toHaveLength(0);
    await settle();
    const tree = render(Panel);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(editable(tree).length).toBeGreaterThan(0);
    expect(findElements(tree, (el) => el.props.value === '42')).toHaveLength(1);
  });
});
