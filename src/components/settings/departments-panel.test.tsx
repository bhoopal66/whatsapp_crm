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
  // The one row, as it is when a switch is toggled.
  fresh: { data: null, error: null } as { data: unknown; error: unknown },
  asked: [] as unknown[][],
  rpc: vi.fn(async () => ({ error: null })),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    rpc: db.rpc,
    from: () => ({
      select: () => ({
        eq: (...first: unknown[]) => ({
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve(db.answer).then(resolve),
          eq: (...second: unknown[]) => ({
            maybeSingle: async () => {
              db.asked.push(first, second);
              return db.fresh;
            },
          }),
        }),
      }),
    }),
  }),
}));

import { toast } from 'sonner';
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
  db.asked = [];
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

  const loadWith = async (data: unknown) => {
    db.answer = { data, error: null };
    render(DepartmentsPanel);
    await settle();
  };
  const switchOf = (id: string) =>
    findElements(
      render(DepartmentsPanel),
      (el) => el.props['aria-labelledby'] === id
    )[0];
  const toggle = async (id: string, on: boolean) => {
    (switchOf(id).props.onCheckedChange as (on: boolean) => void)(on);
    await settle();
  };

  it('a switch sends the other column as it is stored now, not as it was loaded', async () => {
    // Loaded unrestricted; another admin has restricted HR since.
    await loadWith([{ department: 'hr', own_inbox: false, restricted: false }]);
    db.fresh = {
      data: { department: 'hr', own_inbox: false, restricted: true },
      error: null,
    };
    await toggle('dept-hr-own_inbox', true);
    expect(db.asked).toEqual([
      ['account_id', 'acc-1'],
      ['department', 'hr'],
    ]);
    expect(db.rpc).toHaveBeenCalledWith('set_department_settings', {
      p_department: 'hr',
      p_own_inbox: true,
      p_restricted: true,
    });
    // And the screen now shows what is stored.
    expect(switchOf('dept-hr-restricted').props.checked).toBe(true);
  });

  it('a failed re-read saves nothing and says so', async () => {
    await loadWith([{ department: 'hr', own_inbox: true, restricted: true }]);
    db.fresh = { data: null, error: { message: 'timeout' } };
    await toggle('dept-hr-own_inbox', false);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('rereadFailed');
    expect(switchOf('dept-hr-own_inbox').props).toMatchObject({
      checked: true,
      disabled: false,
    });
  });

  it('a department never saved keeps its built-in other switch', async () => {
    await loadWith([]);
    db.fresh = { data: null, error: null };
    await toggle('dept-hr-own_inbox', false);
    expect(db.rpc).toHaveBeenCalledWith('set_department_settings', {
      p_department: 'hr',
      p_own_inbox: false,
      p_restricted: true,
    });
  });

  it('after Retry, the switches are back', async () => {
    db.answer = { data: null, error: { message: 'timeout' } };
    render(DepartmentsPanel);
    await settle();
    db.answer = { data: [], error: null };
    retry(render(DepartmentsPanel));
    render(DepartmentsPanel);
    await settle();
    expect(editable(render(DepartmentsPanel)).length).toBeGreaterThan(0);
  });
});
