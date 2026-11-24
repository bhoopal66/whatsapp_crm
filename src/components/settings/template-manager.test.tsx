import { beforeEach, describe, expect, it, vi } from 'vitest';

// Nothing told an admin that a template was never synced with Meta.
vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('next-intl', () => {
  const key = (k: string, values?: { reason?: string }) =>
    values?.reason ? `${k}: ${values.reason}` : k;
  const t = Object.assign(key, { rich: key, raw: key });
  return { useTranslations: () => t };
});
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
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
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { toast } from 'sonner';

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

describe('what a save says', () => {
  /** Every toast the save showed, as [kind, text]. */
  async function saved(meta: unknown) {
    const answer = { ok: true, json: async () => ({ success: true, meta }) };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer)
    );
    render(TemplateManager);
    await settle();
    const [submit] = findElements(
      render(TemplateManager),
      (el) => el.type === Button && el.props.children === 'submitApproval'
    );
    await (submit.props.onClick as () => Promise<void>)();
    vi.unstubAllGlobals();
    return (['success', 'warning', 'error'] as const).flatMap((kind) =>
      vi.mocked(toast[kind]).mock.calls.map(([text]) => [kind, text])
    );
  }
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [
      { submitted: true, status: 'PENDING' },
      'success',
      'toastSubmitNewSuccess',
    ],
    [
      { submitted: true, status: 'REJECTED' },
      'error',
      'toastMetaRefused: REJECTED',
    ],
    [
      { submitted: false, error: 'Bad footer' },
      'error',
      'toastMetaRefused: Bad footer',
    ],
    [
      { submitted: false, reason: 'no_meta_number' },
      'success',
      'toastSavedLinkedOnly',
    ],
    [
      { submitted: false, reason: 'meta_unavailable' },
      'warning',
      'toastSavedMetaUnavailable',
    ],
    [{ submitted: false, reason: 'edit' }, 'success', 'toastEditSaved'],
  ])('%j', async (meta, kind, text) => {
    expect(await saved(meta)).toEqual([[kind, text]]);
  });

  it('is never "submitted" for an answer that does not say so', async () => {
    expect(await saved(undefined)).toEqual([
      ['warning', 'toastSavedMetaUnavailable'],
    ]);
  });
});

it('a refused row says who refused it, and why', async () => {
  render(TemplateManager);
  await settle();
  expect(
    findElements(
      render(TemplateManager),
      (el) => el.props.children === 'metaRefusedIt: No'
    )
  ).toHaveLength(1);
});
