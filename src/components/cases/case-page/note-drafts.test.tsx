import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('next-intl', () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => 'en',
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/meetings/use-workspace-members', () => ({
  useWorkspaceMembers: () => ({ members: [], nameOf: () => null }),
}));
const send = vi.hoisted(() => vi.fn());
vi.mock('./case-dialogs', () => ({ sendCaseRequest: send }));
vi.mock('./tab-kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tab-kit')>()),
  useCaseResource: () => ({ data: [], failed: false, reload: vi.fn() }),
}));

import { Textarea } from '@/components/ui/textarea';
import type { CaseTabProps } from '@/lib/cases/case-page';
import { findElements, render, resetHooks, settle } from '@/test/hook-renderer';

import { NotesTab } from './notes-tab';
import { useNoteDrafts } from './use-note-drafts';

const detail = {
  permissions: { canWrite: true },
} as unknown as CaseTabProps['detail'];

/** The page's draft plus the notes tab, as the case page renders them. */
const page = (caseId = 'c-1') =>
  findElements(
    render(() =>
      NotesTab({
        caseId,
        detail,
        onChanged: () => {},
        draft: useNoteDrafts(caseId),
      })
    ),
    (el) => el.type === Textarea
  )[0].props as {
    value: string;
    onChange: (e: object) => void;
    onKeyDown: (e: object) => void;
  };
const type = (text: string, caseId?: string) =>
  page(caseId).onChange({
    target: { value: text, selectionStart: text.length },
  });
const ENTER = { key: 'Enter', ctrlKey: true };

beforeEach(() => {
  resetHooks();
  vi.clearAllMocks();
});

describe('case note draft', () => {
  it('lives outside the tab, one per case', () => {
    let caseId = 'c-1';
    const draft = () => render(() => useNoteDrafts(caseId));
    draft().setBody('half a note');
    caseId = 'c-2';
    expect(draft().body).toBe('');
    caseId = 'c-1';
    expect(draft().body).toBe('half a note');
  });

  it('posts once, however often Ctrl+Enter is pressed', async () => {
    let answer: (r: object) => void = () => {};
    send.mockReturnValue(new Promise((r) => (answer = r)));
    type('once');
    const { onKeyDown } = page();
    onKeyDown(ENTER);
    onKeyDown(ENTER);
    page().onKeyDown(ENTER);
    expect(send).toHaveBeenCalledTimes(1);
    answer({ ok: true, status: 200, json: {} });
    await settle();
    expect(page().value).toBe('');
  });

  it('keeps text written while the post was on its way', async () => {
    let answer: (r: object) => void = () => {};
    send.mockReturnValue(new Promise((r) => (answer = r)));
    type('first');
    page().onKeyDown(ENTER);
    type('first and more');
    answer({ ok: true, status: 200, json: {} });
    await settle();
    expect(page().value).toBe('first and more');
  });

  it('a refused post may be sent again', async () => {
    send.mockResolvedValue({ ok: false, status: 500, json: null });
    type('again');
    page().onKeyDown(ENTER);
    await settle();
    expect(page().value).toBe('again');
    page().onKeyDown(ENTER);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
