import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('next-intl', () => {
  const t = (k: string) => k;
  return { useTranslations: () => t };
});
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { ErrorState } from '@/components/dashboard/error-state';
import { Input } from '@/components/ui/input';
import { findElements, render, resetHooks, settle } from '@/test/hook-renderer';
import { QuickRepliesManager } from './quick-replies-manager';

const screen = () => render(QuickRepliesManager);
const errors = () => findElements(screen(), (el) => el.type === ErrorState);
const has = (text: string) =>
  findElements(screen(), (el) => el.props.children === text).length > 0;
const answer = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});
const ONE = {
  quick_replies: [
    { id: 'qr-1', title: 'Hello', kind: 'text', content_text: 'Old words' },
  ],
};

beforeEach(() => {
  resetHooks();
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe('quick replies that could not be read', () => {
  it.each<[string, () => Promise<unknown>]>([
    ['offline', () => Promise.reject(new Error('offline'))],
    ['a server error', async () => answer({ error: 'x' }, 500)],
    ['an answer without a list', async () => answer({})],
  ])('%s: an error with Retry, not an empty list', async (_name, f) => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(f)
      .mockResolvedValue(answer(ONE));
    vi.stubGlobal('fetch', fetchMock);
    screen();
    await settle();
    expect(errors()).toHaveLength(1);
    expect(has('empty')).toBe(false);
    (errors()[0].props.onRetry as () => void)();
    await settle();
    expect(errors()).toHaveLength(0);
    expect(has('Hello')).toBe(true);
  });
});

it('saving one that was removed says so, keeps the text, and can add it again', async () => {
  const calls: string[] = [];
  let removed = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'PATCH') {
        removed = true;
        return answer({ error: 'x' }, 404);
      }
      return answer(removed ? { quick_replies: [] } : ONE);
    })
  );
  screen();
  await settle();
  const click = (label: string) => {
    const [button] = findElements(screen(), (el) => {
      const c = el.props.children;
      return (
        typeof el.props.onClick === 'function' &&
        (el.props['aria-label'] === label ||
          c === label ||
          (Array.isArray(c) && c.includes(label)))
      );
    });
    (button.props.onClick as () => void)();
  };
  click('edit');
  const [title] = findElements(screen(), (el) => el.type === Input);
  (title.props.onChange as (e: unknown) => void)({
    target: { value: 'My new title' },
  });
  click('save');
  await settle();
  await settle();
  expect(toast.error).toHaveBeenCalledWith('removed');
  const [kept] = findElements(screen(), (el) => el.type === Input);
  expect(kept.props.value).toBe('My new title');
  click('save');
  await settle();
  expect(calls).toContain('PATCH /api/quick-replies/qr-1');
  expect(calls).toContain('POST /api/quick-replies');
});
