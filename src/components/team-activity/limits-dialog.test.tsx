import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('next-intl', () => {
  const t = (k: string) => k;
  return { useTranslations: () => t };
});
vi.mock('@/components/team-activity/new-chat-notice-section', () => ({
  NewChatNoticeSection: () => null,
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { ErrorState } from '@/components/dashboard/error-state';
import { TEAM_ACTIVITY_DEFAULTS } from '@/lib/team-activity/limits';
import { findElements, render, resetHooks, settle } from '@/test/hook-renderer';
import { LimitsDialog, LimitsForm } from './limits-dialog';

const limits = { ...TEAM_ACTIVITY_DEFAULTS, timezone: 'Asia/Dubai' };
const answer = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});
let open = true;
const dialog = () =>
  render(() => LimitsDialog({ open, onOpenChange: vi.fn(), onSaved: vi.fn() }));
const forms = () => findElements(dialog(), (el) => el.type === LimitsForm);
const errors = () => findElements(dialog(), (el) => el.type === ErrorState);

beforeEach(() => {
  resetHooks();
  vi.clearAllMocks();
  open = true;
});
afterEach(() => vi.unstubAllGlobals());

it('reads the limits each time it opens, and not before', async () => {
  const fetchMock = vi.fn(async () =>
    answer({ settings: limits, saved: true, updatedAt: 'v2' })
  );
  vi.stubGlobal('fetch', fetchMock);
  open = false;
  dialog();
  expect(fetchMock).not.toHaveBeenCalled();
  open = true;
  expect(forms()).toHaveLength(0);
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(forms()[0].props.loaded).toEqual({
    limits,
    saved: true,
    updatedAt: 'v2',
  });
});

it('a failed read shows an error with Retry and no form', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(answer({ error: 'x' }, 500))
      .mockResolvedValue(
        answer({ settings: limits, saved: true, updatedAt: 'v2' })
      )
  );
  dialog();
  await settle();
  expect(forms()).toHaveLength(0);
  (errors()[0].props.onRetry as () => void)();
  dialog();
  await settle();
  expect(forms()).toHaveLength(1);
});

it('Save sends the version it loaded; a 409 says so and reloads', async () => {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
    answer({ error: 'x', code: 'STALE' }, 409)
  );
  vi.stubGlobal('fetch', fetchMock);
  const onStale = vi.fn();
  const onSaved = vi.fn();
  const form = render(() =>
    LimitsForm({
      loaded: { limits, saved: true, updatedAt: 'v2' },
      onSaved,
      onStale,
      onClose: vi.fn(),
    })
  );
  const [saveButton] = findElements(form, (el) => {
    const children = el.props.children;
    return Array.isArray(children) && children.includes('save');
  });
  (saveButton.props.onClick as () => void)();
  await settle();
  const sent = JSON.parse(String(fetchMock.mock.calls[0][1].body));
  expect(sent.expectedUpdatedAt).toBe('v2');
  expect(toast.error).toHaveBeenCalledWith('stale');
  expect(onStale).toHaveBeenCalledTimes(1);
  expect(onSaved).not.toHaveBeenCalled();
});
