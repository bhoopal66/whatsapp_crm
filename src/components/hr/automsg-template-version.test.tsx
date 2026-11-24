import { beforeEach, describe, expect, it, vi } from 'vitest';

// A template is saved only over the row its editor was filled from (317).
vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc }) }));

import { toast } from 'sonner';

import { editorSlots, type EditorSlot } from '@/lib/hr/automsg/editor-view';
import type { AutoMsgTemplateView } from '@/lib/hr/automsg/api';
import { findElements, render, resetHooks, settle } from '@/test/hook-renderer';

import { TemplateCard } from './automsg-templates';

const row = (body: string, at: string): AutoMsgTemplateView => ({
  kind: 'cv_ack',
  language: 'en',
  channel: 'whatsapp',
  body,
  metaTemplateName: 'cv_ack',
  approvalStatus: 'draft',
  category: 'utility',
  updatedAt: at,
});
/** What `hr_automsg_config` answers for one stored row. */
const config = (body: string, at: string) => ({
  templates: [
    {
      kind: 'cv_ack',
      language: 'en',
      channel: 'whatsapp',
      body,
      meta_template_name: 'cv_ack',
      approval_status: 'draft',
      category: 'utility',
      updated_at: at,
    },
  ],
});
const slotOf = (body: string, at: string) => editorSlots([row(body, at)])[0];

let slot: EditorSlot;
const onSaved = vi.fn();
const view = () => TemplateCard({ slot, role: 'admin', onSaved });
const body = () =>
  findElements(render(view), (el) => el.props.rows === 4)[0].props as {
    value: string;
    onChange: (e: object) => void;
  };
const button = (label: string) =>
  findElements(
    render(view),
    (el) => !!el.props.onClick && el.props.children === label
  )[0]?.props as { onClick: () => void; disabled?: boolean } | undefined;
const notice = () =>
  findElements(render(view), (el) => el.props.role === 'alert').length > 0;
const type = (value: string) => body().onChange({ target: { value } });

beforeEach(() => {
  resetHooks();
  vi.clearAllMocks();
  slot = slotOf('One {name}', 't1');
  onSaved.mockImplementation(() => {});
});

describe('an HR template', () => {
  it('sends the version it was filled from', async () => {
    rpc.mockResolvedValue({ data: config('Mine {name}', 't2'), error: null });
    type('Mine {name}');
    button('templates.save')!.onClick();
    await settle();
    expect(rpc).toHaveBeenCalledWith(
      'hr_automsg_template_set',
      expect.objectContaining({ p_body: 'Mine {name}', p_expected: 't1' })
    );
    // Its own save is no change by somebody else.
    slot = slotOf('Mine {name}', 't2');
    expect(notice()).toBe(false);
    type('Mine again {name}');
    button('templates.save')!.onClick();
    await settle();
    expect(rpc.mock.lastCall?.[1]).toMatchObject({ p_expected: 't2' });
  });

  it('a seed is saved over nothing', async () => {
    slot = editorSlots([])[0];
    rpc.mockResolvedValue({ data: config('Seed', 't1'), error: null });
    type('First {name}');
    button('templates.save')!.onClick();
    await settle();
    expect(rpc.mock.lastCall?.[1]).toMatchObject({ p_expected: null });
  });

  it('a refused save keeps the text, and Reload takes the other one', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'changed', hint: 'STALE', code: '22023' },
    });
    type('Mine {name}');
    button('templates.save')!.onClick();
    await settle();
    expect(toast.error).toHaveBeenCalledWith('error.STALE');
    expect(body().value).toBe('Mine {name}');
    expect(notice()).toBe(true);
    expect(button('templates.save')!.disabled).toBe(true);
    onSaved.mockImplementation(() => {
      slot = slotOf('Theirs {name}', 't2');
    });
    button('templates.reload')!.onClick();
    await settle();
    expect(body().value).toBe('Theirs {name}');
    expect(notice()).toBe(false);
  });

  it('a reload shows a newer row in an untouched card only', async () => {
    render(view);
    slot = slotOf('Theirs {name}', 't2');
    expect(body().value).toBe('Theirs {name}');
    expect(notice()).toBe(false);
    type('Mine {name}');
    slot = slotOf('Theirs again {name}', 't3');
    expect(body().value).toBe('Mine {name}');
    expect(notice()).toBe(true);
    // The version of the text it shows, not of the row behind the notice.
    rpc.mockResolvedValue({ data: null, error: { hint: 'STALE' } });
    button('templates.save')!.onClick();
    await settle();
    expect(rpc.mock.lastCall?.[1]).toMatchObject({ p_expected: 't2' });
  });

  it('what is typed while a save runs stays', async () => {
    let answer: (v: unknown) => void = () => {};
    rpc.mockReturnValue(new Promise((r) => (answer = r)));
    type('Mine {name}');
    button('templates.save')!.onClick();
    type('Mine and more {name}');
    answer({ data: config('Mine {name}', 't2'), error: null });
    await settle();
    slot = slotOf('Mine {name}', 't2');
    expect(body().value).toBe('Mine and more {name}');
    expect(notice()).toBe(false);
  });

  it('saving an untouched card after a reload keeps what it shows', async () => {
    render(view);
    slot = slotOf('Theirs {name}', 't2');
    rpc.mockResolvedValue({ data: config('Theirs {name}', 't3'), error: null });
    button('templates.save')!.onClick();
    await settle();
    expect(rpc.mock.lastCall?.[1]).toMatchObject({ p_expected: 't2' });
    expect(body().value).toBe('Theirs {name}');
    slot = slotOf('Theirs {name}', 't3');
    expect(body().value).toBe('Theirs {name}');
    expect(notice()).toBe(false);
  });
});
