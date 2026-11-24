import { beforeEach, describe, expect, it, vi } from 'vitest';

// Nothing told an admin that a template was never synced with Meta.
vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('next-intl', () => {
  const key = (k: string) => k;
  const t = Object.assign(key, { rich: key, raw: key });
  return { useTranslations: () => t };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'u' }, loading: false }),
}));
const state = vi.hoisted(() => ({ numbers: [] as unknown[] }));
vi.mock('@/hooks/use-whatsapp-numbers', () => ({
  useAccountNumbers: () => state.numbers,
}));
const ROWS = [
  { id: 'never', name: 'a', status: 'APPROVED' },
  { id: 'metas', name: 'b', status: 'APPROVED', meta_template_id: 'M' },
  { id: 'refused', name: 'c', status: 'APPROVED', submission_error: 'No' },
];
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ order: async () => ({ data: ROWS, error: null }) }),
    }),
  }),
}));

import { findElements, render, resetHooks, settle } from '@/test/hook-renderer';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';

import { TemplateManager } from './template-manager';

async function badged() {
  render(TemplateManager);
  await settle();
  return findElements(render(TemplateManager), (el) => el.type === Card)
    .filter(
      (card) =>
        findElements(
          card,
          (el) => el.type === Badge && el.props.children === 'notLinkedToMeta'
        ).length
    )
    .map((card) => card.key);
}

beforeEach(() => resetHooks());

describe('the "not linked to Meta" badge', () => {
  it('is on a row Meta never heard of, not on a refused one', async () => {
    state.numbers = [{ id: 'm', provider: 'meta' }];
    expect(await badged()).toEqual(['never']);
  });

  it('is not shown without a Meta number', async () => {
    state.numbers = [{ id: 'w', provider: 'whapi' }];
    expect(await badged()).toEqual([]);
  });
});
