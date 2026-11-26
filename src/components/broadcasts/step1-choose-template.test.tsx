import { beforeEach, describe, expect, it, vi } from 'vitest';

// The wizard listed every row marked approved. A save marks one approved
// before Meta answers, so a campaign could be built on a template Meta
// refused, and every recipient failed.
vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));
const state = vi.hoisted(() => ({
  numbers: [] as unknown[],
  route: null as { config_id: string } | null,
}));
vi.mock('@/hooks/use-whatsapp-numbers', () => ({
  useAccountNumbers: () => state.numbers,
}));
const ROWS = [
  { id: 'ok', name: 'ok', status: 'APPROVED', meta_template_id: 'M1' },
  { id: 'bad', name: 'bad', status: 'APPROVED', submission_error: 'No' },
];
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        order: async () => ({ data: ROWS, error: null }),
        maybeSingle: async () => ({
          data: table === 'whatsapp_routes' ? state.route : null,
          error: null,
        }),
      };
      return q;
    },
  }),
}));

import { findElements, render, resetHooks, settle } from '@/test/hook-renderer';
import { Button } from '@/components/ui/button';

import { Step1ChooseTemplate } from './step1-choose-template';

const onSelect = vi.fn();
async function open(selectedTemplate: unknown = null) {
  const Screen = () =>
    Step1ChooseTemplate({
      selectedTemplate: selectedTemplate as never,
      onSelect,
      onNext: () => {},
      onBack: () => {},
    });
  render(Screen);
  await settle();
  const all = (type: unknown) =>
    findElements(render(Screen), (el) => el.type === type);
  return {
    choices: all('button').map((el) => el.key),
    blocked: findElements(
      render(Screen),
      (el) => el.props['aria-disabled'] === 'true'
    ).map((el) => el.key),
    nextDisabled: all(Button).at(-1)?.props.disabled,
  };
}

const NUMBERS = [
  { id: 'm', provider: 'meta', is_primary: false, is_personal: false },
  { id: 'w', provider: 'whapi', is_primary: true, is_personal: false },
];

beforeEach(() => {
  resetHooks();
  state.numbers = NUMBERS;
});

describe('the campaign wizard’s templates', () => {
  it('does not let a refused one be chosen when campaigns go out on Meta', async () => {
    state.route = { config_id: 'm' };
    expect(await open(ROWS[1])).toEqual({
      choices: ['ok'],
      blocked: ['bad'],
      nextDisabled: true,
    });
  });

  it('offers it on a linked number, where Meta’s verdict does not matter', async () => {
    state.route = null;
    expect(await open(ROWS[1])).toEqual({
      choices: ['ok', 'bad'],
      blocked: [],
      nextDisabled: false,
    });
  });
});
