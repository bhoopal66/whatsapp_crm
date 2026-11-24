import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

// A case setting is saved against what the screen had loaded (309).
vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('next-intl', () => ({
  useTranslations: () => (k: string, v?: { list?: string }) =>
    v?.list ? `${k}:${v.list}` : k,
  useLocale: () => 'en',
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountRole: 'owner' }),
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => true }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { findElements, render, resetHooks, settle } from '@/test/hook-renderer';

import {
  ChangedNotice,
  FileSpecEditor,
  IntakeWording,
} from './case-files-settings';
import { StagesEditor } from './cases-settings-panel';

type Reply = { status: number; body: unknown };
let replies: (url: string, init?: RequestInit) => Reply;
const sent: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  resetHooks();
  vi.clearAllMocks();
  sent.length = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.body) sent.push({ url, body: JSON.parse(String(init.body)) });
    const { status, body } = replies(url, init);
    return { ok: status < 300, status, json: async () => body };
  });
});
afterEach(() => vi.unstubAllGlobals());

const textOf = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(textOf).join('') : String(node ?? '');
const button = (view: () => ReactNode, label: string) =>
  findElements(
    render(view),
    (el) =>
      !!el.props.onClick &&
      textOf(el.props.children as ReactNode).endsWith(label)
  )[0];
async function click(view: () => ReactNode, label: string) {
  (button(view, label).props.onClick as () => void)();
  await settle();
}
async function load(view: () => ReactNode) {
  render(view);
  await settle();
}

describe('the stage list', () => {
  const view = () => StagesEditor({ code: 'ADCB', onSaved: () => {} });
  const first = [
    'Docs',
    'Review',
    'Approved',
    'Declined',
    'Withdrawn',
    'Closed',
  ];
  const dialogs = () =>
    findElements(render(view), (el) => el.type === ConfirmDialog);
  async function edit() {
    const input = findElements(
      render(view),
      (el) => el.props['aria-label'] === 'stageLabel'
    )[1];
    (input.props.onChange as (e: object) => void)({
      target: { value: 'Bank review' },
    });
  }

  it('sends the loaded list; a change elsewhere keeps the typing until Reload', async () => {
    let stages = first;
    replies = (_u, init) =>
      init?.method === 'PUT'
        ? { status: 409, body: { code: 'STAGES_CHANGED' } }
        : { status: 200, body: { stages, isDefault: false } };
    await load(view);
    await edit();
    stages = [...first].reverse();
    await click(view, 'save');
    expect(sent[0].body.expected).toEqual(first);
    const shown = () =>
      findElements(
        render(view),
        (el) => el.props['aria-label'] === 'stageLabel'
      ).map((el) => el.props.value);
    expect(shown()[1]).toBe('Bank review');
    const notice = findElements(
      render(view),
      (el) => el.type === ChangedNotice
    )[0];
    await (notice.props.onReload as () => Promise<void>)();
    expect(shown()).toEqual(stages);
  });

  it('names what uses a dropped stage, then sends the confirmed save', async () => {
    let confirmed = false;
    replies = (_u, init) => {
      if (init?.method !== 'PUT')
        return { status: 200, body: { stages: first, isDefault: false } };
      confirmed = JSON.parse(String(init.body)).confirmDropped === true;
      return confirmed
        ? { status: 200, body: { count: 6 } }
        : {
            status: 409,
            body: {
              code: 'STAGE_IN_USE',
              mappings: [{ status: 'In review', stage: 'Review' }],
              sla: [{ stage: 'Review', timer: 'bank_response' }],
            },
          };
    };
    await load(view);
    await edit();
    await click(view, 'save');
    const dialog = dialogs().find((d) => d.props.open)!;
    expect(dialog.props.description).toContain('In review (Review)');
    expect(dialog.props.description).toContain(
      'Review (sla.timers.bank_response)'
    );
    (dialog.props.onConfirm as () => void)();
    await settle();
    expect(sent[1].body).toEqual({ ...sent[0].body, confirmDropped: true });
    expect(toast.success).toHaveBeenCalledWith('saved');
  });
});

describe('the file spec', () => {
  const view = () =>
    FileSpecEditor({ code: 'ADCB', products: ['PL'], version: '1' });

  it('sends the rows as they were loaded and shows a change elsewhere', async () => {
    const rows = [
      {
        docKey: 'passport',
        position: 1,
        namePattern: '{{doc}}',
        required: true,
        maxMb: 10,
        allowedMime: ['application/pdf'],
        minValidDays: null,
        merged: true,
      },
      // Not on the document list any more: the editor leaves it out.
      { docKey: 'gone', position: 2, allowedMime: null },
    ];
    replies = (_u, init) =>
      init?.method === 'PUT'
        ? { status: 409, body: { code: 'SPEC_CHANGED' } }
        : {
            status: 200,
            body: {
              product: 'PL',
              requirements: [{ docKey: 'passport', label: 'Passport' }],
              rows,
              usesDefaults: false,
            },
          };
    await load(view);
    await click(view, 'save');
    expect(sent[0].body.expected).toEqual(rows);
    expect(
      findElements(render(view), (el) => el.type === ChangedNotice)
    ).toHaveLength(1);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('the intake wording', () => {
  const view = () => IntakeWording({ canEdit: true });
  const row = (body: string, updatedAt: string) => ({
    templates: [
      { kind: 'document_classify', body, approved: false, updatedAt },
    ],
  });
  const text = () =>
    findElements(
      render(view),
      (el) => el.props.id === 'intake-document_classify'
    )[0];
  async function open() {
    (button(view, 'title').props.onClick as () => void)();
    await load(view);
  }

  it('approves the version shown; a change elsewhere is read again', async () => {
    let now = row('Old', 'v1');
    replies = (_u, init) =>
      init?.method === 'POST'
        ? { status: 409, body: { code: 'TEMPLATE_CHANGED' } }
        : { status: 200, body: now };
    await open();
    now = row('New', 'v2');
    await click(view, 'approve');
    expect(sent[0].body).toEqual({ updatedAt: 'v1' });
    expect(text().props.value).toBe('New');
    await click(view, 'approve');
    expect(sent[1].body).toEqual({ updatedAt: 'v2' });
  });

  it('a save names the version shown and keeps the typing over a change', async () => {
    let now = row('Old', 'v1');
    replies = (_u, init) =>
      init?.method === 'PUT'
        ? { status: 409, body: { code: 'TEMPLATE_CHANGED' } }
        : { status: 200, body: now };
    await open();
    (text().props.onChange as (e: object) => void)({
      target: { value: 'Mine' },
    });
    now = row('Theirs', 'v2');
    await click(view, 'save');
    expect(sent[0].body).toEqual({ body: 'Mine', updatedAt: 'v1' });
    expect(text().props.value).toBe('Mine');
    await click(view, 'save');
    expect(sent[1].body).toEqual({ body: 'Mine', updatedAt: 'v2' });
  });

  it('a failed first read offers Reload, never "no wording"', async () => {
    let up = false;
    replies = () =>
      up
        ? { status: 200, body: row('Old', 'v1') }
        : { status: 500, body: null };
    await open();
    expect(text()).toBeUndefined();
    up = true;
    const failed = findElements(
      render(view),
      (el) => typeof el.props.onRetry === 'function'
    )[0];
    (failed.props.onRetry as () => void)();
    await load(view);
    expect(text().props.value).toBe('Old');
  });

  it("after a save the approval names the saver's own version", async () => {
    let now = row('Old', 'v1');
    replies = (_u, init) =>
      init?.method === 'POST'
        ? { status: 409, body: { code: 'SELF_APPROVAL' } }
        : { status: 200, body: now };
    await open();
    (text().props.onChange as (e: object) => void)({
      target: { value: 'Mine' },
    });
    now = row('Mine', 'v2');
    await click(view, 'save');
    await click(view, 'approve');
    expect(sent[1].body).toEqual({ updatedAt: 'v2' });
  });
});
