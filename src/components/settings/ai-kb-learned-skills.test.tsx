import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

// "What it has learned": a failed read is an error with Retry, a change
// cannot be sent twice, a refusal is said and the list is kept, and an
// older answer never overwrites a newer one.
vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('next-intl', () => {
  const t = (k: string, v?: object) => (v ? `${k}:${JSON.stringify(v)}` : k);
  return { useTranslations: () => t };
});
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { ErrorState } from '@/components/dashboard/error-state';
import { Button } from '@/components/ui/button';
import { findElements, render, resetHooks, settle } from '@/test/hook-renderer';
import { AiKbLearnedSkills } from './ai-kb-learned-skills';

const row = (id: string, status = 'active') => ({
  id,
  kind: 'general',
  title: `Title ${id}`,
  principle: `Principle ${id}`,
  status,
});

type Reply = { status: number; body: unknown } | Error | 'never';
let list: Reply;
let change: Reply;
let calls: string[];

const reply = (r: Reply) => {
  if (r === 'never') return new Promise(() => {});
  if (r instanceof Error) throw r;
  return { ok: r.status < 300, status: r.status, json: async () => r.body };
};

beforeEach(() => {
  resetHooks();
  vi.clearAllMocks();
  list = { status: 200, body: { skills: [row('a'), row('b')] } };
  change = { status: 200, body: { id: 'a', status: 'retired' } };
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url} ${init?.body ?? ''}`.trim());
    return reply(init?.method === 'PATCH' ? change : list);
  });
});
afterEach(() => vi.unstubAllGlobals());

const draw = () => render(() => AiKbLearnedSkills({ accountId: 'acc' }));
async function drawn() {
  draw();
  await settle();
  return draw();
}
const textOf = (node: ReactNode): string => {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node)
    return textOf((node.props as { children?: ReactNode }).children);
  return typeof node === 'string' ? node : '';
};
const errors = (tree: ReactNode) =>
  findElements(tree, (el) => el.type === ErrorState);
const buttons = (tree: ReactNode) =>
  findElements(tree, (el) => el.type === Button);
const click = (tree: ReactNode, i: number) =>
  (buttons(tree)[i].props.onClick as () => void)();

describe('reading the list', () => {
  it('shows loading, not "empty", until the answer', async () => {
    list = 'never';
    const tree = await drawn();
    expect(textOf(tree)).toContain('loading');
    expect(textOf(tree)).not.toContain('empty');
  });

  it.each<[string, Reply]>([
    ['a server error', { status: 500, body: { error: 'x' } }],
    ['offline', new Error('offline')],
    ['an answer without a list', { status: 200, body: {} }],
  ])('%s is an error with Retry, never an empty list', async (_n, r) => {
    list = r;
    const tree = await drawn();
    expect(errors(tree)).toHaveLength(1);
    expect(errors(tree)[0].props.message).toBe('loadFailed');
    expect(textOf(tree)).not.toContain('empty');

    list = { status: 200, body: { skills: [row('a')] } };
    (errors(tree)[0].props.onRetry as () => void)();
    await settle();
    const again = draw();
    expect(errors(again)).toHaveLength(0);
    expect(textOf(again)).toContain('Title a');
  });

  it('says so when there are no rules', async () => {
    list = { status: 200, body: { skills: [] } };
    expect(textOf(await drawn())).toContain('empty');
  });
});

describe('retire and restore', () => {
  it('sends one change however often it is clicked', async () => {
    const tree = await drawn();
    click(tree, 0);
    click(tree, 0);
    click(tree, 1);
    await settle();
    expect(calls.filter((c) => c.startsWith('PATCH'))).toEqual([
      'PATCH /api/ai/kb/learn/skills/a {"status":"retired"}',
    ]);
  });

  it('moves the retired rule down and enables the buttons again', async () => {
    const tree = await drawn();
    click(tree, 0);
    await settle();
    const after = draw();
    expect(textOf(after).indexOf('Title b')).toBeLessThan(
      textOf(after).indexOf('Title a')
    );
    expect(buttons(after).every((b) => !b.props.disabled)).toBe(true);
  });

  it.each<[string, Reply, string]>([
    ['the cap', { status: 409, body: { error: 'x' } }, 'capReached'],
    ['a missing rule', { status: 404, body: { error: 'x' } }, 'gone'],
    [
      'a server error',
      { status: 500, body: { error: 'db text' } },
      'saveFailed',
    ],
    ['offline', new Error('offline'), 'saveFailed'],
  ])('%s is said and the list is kept', async (_n, r, key) => {
    change = r;
    const tree = await drawn();
    click(tree, 0);
    await settle();
    expect(toast.error).toHaveBeenCalledWith(key);
    const after = draw();
    expect(textOf(after)).toContain('Title a');
    expect(textOf(after)).toContain('Title b');
    expect(errors(after)).toHaveLength(0);
    expect(buttons(after).every((b) => !b.props.disabled)).toBe(true);
  });
});

describe('late answers', () => {
  it('an older read answering after a newer one does not overwrite it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      if (calls.length === 1) {
        await gate;
        return reply({ status: 200, body: { skills: [row('old')] } });
      }
      return reply({ status: 200, body: { skills: [row('new')] } });
    });
    render(() => AiKbLearnedSkills({ accountId: 'acc-1' }));
    // The workspace changes while the first read is still on its way.
    render(() => AiKbLearnedSkills({ accountId: 'acc-2' }));
    await settle();
    release();
    await settle();
    const tree = render(() => AiKbLearnedSkills({ accountId: 'acc-2' }));
    expect(textOf(tree)).toContain('Title new');
    expect(textOf(tree)).not.toContain('Title old');
  });
});
