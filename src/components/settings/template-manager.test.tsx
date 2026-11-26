import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('Submit to Meta', () => {
  const LOCAL = {
    id: 'never',
    name: 'a',
    category: 'Utility',
    language: 'en',
    body_text: 'Hello',
    status: 'DRAFT',
  };
  const META = [{ id: 'm', provider: 'meta' }];

  async function screen(rows: unknown[], numbers: unknown[] = META) {
    state.numbers = numbers;
    ROWS.splice(0, ROWS.length, ...(rows as typeof ROWS));
    render(TemplateManager);
    await settle();
    return render(TemplateManager);
  }
  const shows = (text: string) =>
    findElements(render(TemplateManager), (el) => el.props.children === text)
      .length;
  const button = (text: string) =>
    findElements(render(TemplateManager), (el) => {
      if (el.type !== Button) return false;
      return findElements(el, (x) => x.props.children === text).length > 0;
    });
  const click = (text: string) =>
    (button(text)[0].props.onClick as () => Promise<void> | void)();
  const answer = (status: number, body: unknown) => {
    const call = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(body), { status })
    );
    vi.stubGlobal('fetch', call);
    return call;
  };

  const before = [...ROWS];
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    ROWS.splice(0, ROWS.length, ...before);
  });

  it.each([
    ['a draft', {}, META, 1],
    ['one for linked numbers', { status: 'APPROVED' }, META, 1],
    ['a refused one', { submission_error: 'No' }, META, 1],
    ['one Meta has', { meta_template_id: 'M' }, META, 0],
    ['one with Meta’s verdict', { status: 'REJECTED' }, META, 0],
    ['no Meta number', {}, [{ id: 'w', provider: 'whapi' }], 0],
  ])('is offered: %s', async (_, over, numbers, count) => {
    await screen([{ ...LOCAL, ...over }], numbers);
    expect(button('submitToMeta')).toHaveLength(count);
  });

  it('asks first, sends the row’s own content, and shows the answer', async () => {
    await screen([LOCAL]);
    const call = answer(200, {
      template: { ...LOCAL, status: 'PENDING', meta_template_id: 'M1' },
      meta: { submitted: true, status: 'PENDING' },
    });
    void click('submitToMeta');
    expect(call).not.toHaveBeenCalled();
    expect(shows('submitToMetaDesc')).toBe(1);

    const done = click('submitToMetaConfirm');
    expect(button('submitToMeta')[0].props.disabled).toBe(true);
    await done;

    expect(call.mock.calls[0][0]).toBe('/api/whatsapp/templates/submit');
    expect(JSON.parse(String(call.mock.calls[0][1]?.body))).toEqual({
      template_id: 'never',
      name: 'a',
      category: 'Utility',
      language: 'en',
      body_text: 'Hello',
    });
    expect(toast.success).toHaveBeenCalledWith('toastSubmitNewSuccess');
    // Meta's now: no second submit.
    expect(button('submitToMeta')).toHaveLength(0);
  });

  it('a refusal is in the toast and on the row', async () => {
    await screen([LOCAL]);
    answer(200, {
      template: { ...LOCAL, submission_error: 'Bad body' },
      meta: { submitted: false, error: 'Bad body' },
    });
    void click('submitToMeta');
    await click('submitToMetaConfirm');
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe(
      'metaRefusedIt: Bad body'
    );
    expect(shows('metaRefusedIt: Bad body')).toBe(1);
    // And again before the next try.
    void click('submitToMeta');
    expect(shows('submitRefusedBefore: Bad body')).toBe(1);
  });

  it.each([
    ['TEMPLATE_EXISTS', 'toastMetaHasIt'],
    ['META_HAS_IT', 'toastMetaHasIt'],
    ['META_NO_ANSWER', 'toastMetaNoAnswer'],
    ['TEMPLATE_GONE', 'toastTemplateGone'],
    ['META_ACCEPTED_NOT_SAVED', 'toastMetaAcceptedNotSaved'],
  ])('%s is told in words', async (code, text) => {
    await screen([LOCAL]);
    answer(409, { error: 'x', code });
    void click('submitToMeta');
    await click('submitToMetaConfirm');
    expect(toast.error).toHaveBeenCalledWith(text);
    await settle();
    expect(button('submitToMeta')[0].props.disabled).toBe(false);
  });

  it.each([
    [
      { header_type: 'image', header_media_url: 'https://x/a.png' },
      'media_header',
    ],
    [{ category: 'Authentication' }, 'authentication'],
  ])('says why it cannot go: %j', async (over, why) => {
    await screen([{ ...LOCAL, ...over }]);
    void click('submitToMeta');
    expect(shows(`submitBlocked.${why}`)).toBe(1);
    expect(button('submitToMetaConfirm')).toHaveLength(0);
  });
});
