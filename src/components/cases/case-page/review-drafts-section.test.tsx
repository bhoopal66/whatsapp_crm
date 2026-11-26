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

import { Button } from '@/components/ui/button';
import { findElements, render, resetHooks, settle } from '@/test/hook-renderer';

import { EditDetailsDialog } from './case-dialogs';
import { ReviewDraftsSection } from './review-drafts-section';
import { TabStatus } from './tab-kit';

const DRAFTS = {
  enabled: true,
  drafts: [
    {
      id: 'd-1',
      status: 'pending',
      narrativeSource: 'deterministic',
      body: { narrative: 'n', flags: [] },
      createdAt: '2026-11-25T08:00:00Z',
    },
  ],
};
const json = (status: number, body: unknown) => ({
  ok: status < 300,
  status,
  json: async () => body,
});
const buttons = (el: Parameters<typeof findElements>[0]) =>
  findElements(el, (e) => e.type === Button);

beforeEach(() => {
  resetHooks();
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe('ReviewDraftsSection', () => {
  const section = () => ReviewDraftsSection({ caseId: 'c-1', canWrite: true });

  it('says a first read failed, and Retry reads it again', async () => {
    let answer = json(500, null);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer)
    );
    render(section);
    await settle();
    const status = findElements(render(section), (e) => e.type === TabStatus);
    expect(status[0].props).toMatchObject({
      failed: true,
      error: 'loadFailed',
    });
    answer = json(200, DRAFTS);
    (status[0].props.onRetry as () => void)();
    await settle();
    expect(buttons(render(section))).toHaveLength(2);
  });

  it('a lost decision says so, frees the buttons and keeps the note', async () => {
    let offline = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (offline) throw new TypeError('offline');
        return json(200, DRAFTS);
      })
    );
    render(section);
    await settle();
    offline = true;
    const [agree] = buttons(render(section));
    await (agree.props.onClick as () => Promise<void>)();
    expect(toast.error).toHaveBeenCalledWith('decideFailed');
    const after = buttons(render(section));
    expect(after).toHaveLength(2);
    expect(after[0].props.disabled).toBe(false);
  });
});

describe('EditDetailsDialog', () => {
  const dialog = () =>
    EditDetailsDialog({
      open: true,
      onOpenChange: () => {},
      onChanged: () => {},
      detail: {
        case: {
          id: 'c-1',
          bankCode: 'B',
          bankName: 'Bank',
          product: 'Loan',
          amount: '1000',
          priority: 'normal',
          dueAt: null,
        },
      } as unknown as Parameters<typeof EditDetailsDialog>[0]['detail'],
    });
  const alerts = () =>
    findElements(render(dialog), (e) => e.props.role === 'alert').map(
      (e) => e.props.children
    );

  it('a failed bank list offers Retry', async () => {
    let answer = json(500, null);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer)
    );
    render(dialog);
    await settle();
    expect(alerts()).toEqual(['edit.banksFailed']);
    answer = json(200, { banks: [{ code: 'B', name: 'Bank' }] });
    const retry = buttons(render(dialog)).find(
      (b) => b.props.children === 'retry'
    )!;
    (retry.props.onClick as () => void)();
    render(dialog);
    await settle();
    expect(alerts()).toEqual([]);
  });
});
