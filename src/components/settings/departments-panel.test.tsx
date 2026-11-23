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

const db = vi.hoisted(() => ({
  answer: { data: null, error: null } as {
    data: unknown;
    error: unknown;
  },
  rpc: vi.fn(async () => ({ error: null })),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    rpc: db.rpc,
    from: () => ({
      select: () => ({ eq: async () => db.answer }),
    }),
  }),
}));

import { ErrorState } from '@/components/dashboard/error-state';
import { Switch } from '@/components/ui/switch';
import { findElements, render, resetHooks, settle } from '@/test/hook-renderer';
import { DepartmentsPanel } from './departments-panel';

const errors = (tree: ReactNode) =>
  findElements(tree, (el) => el.type === ErrorState);
const editable = (tree: ReactNode) =>
  findElements(tree, (el) => el.type === Switch);
const retry = (tree: ReactNode) =>
  (errors(tree)[0].props.onRetry as () => void)();

beforeEach(() => {
  resetHooks();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('DepartmentsPanel', () => {
  it('a failed load shows an error with Retry and no switches', async () => {
    db.answer = { data: null, error: { message: 'timeout' } };
    render(DepartmentsPanel);
    await settle();
    const tree = render(DepartmentsPanel);
    expect(errors(tree)).toHaveLength(1);
    expect(editable(tree)).toHaveLength(0);
  });

  it('after Retry, a switch sends the other column as it was read', async () => {
    db.answer = { data: null, error: { message: 'timeout' } };
    render(DepartmentsPanel);
    await settle();
    // The opposite of HR's built-in defaults, both columns.
    db.answer = {
      data: [{ department: 'hr', own_inbox: false, restricted: false }],
      error: null,
    };
    retry(render(DepartmentsPanel));
    render(DepartmentsPanel);
    await settle();
    const [own] = findElements(
      render(DepartmentsPanel),
      (el) => el.props['aria-labelledby'] === 'dept-hr-own_inbox'
    );
    (own.props.onCheckedChange as (on: boolean) => void)(true);
    expect(db.rpc).toHaveBeenCalledWith('set_department_settings', {
      p_department: 'hr',
      p_own_inbox: true,
      p_restricted: false,
    });
  });
});
