import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The decisions are tested in lib/kb/learn-settings.test.ts; here, that
// the switch draws them: no switch after a failed load, and a failed save
// put back and said.
vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('next-intl', () => {
  const t = (k: string) => k;
  const format = { dateTime: (d: Date) => d.toISOString() };
  return { useTranslations: () => t, useFormatter: () => format };
});
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { findElements, render, resetHooks, settle } from '@/test/hook-renderer';
import { AiKbLearnSwitch } from './ai-kb-learn-switch';

const answer = (status: number, json: unknown) => async () => ({
  ok: status < 300,
  status,
  json: async () => json,
});
const draw = () =>
  render(() => AiKbLearnSwitch({ accountId: 'a', canEdit: true }));
async function drawn() {
  draw();
  await settle();
  return draw();
}
const switches = (tree: ReturnType<typeof draw>) =>
  findElements(tree, (el) => el.type === Switch);
const buttons = (tree: ReturnType<typeof draw>) =>
  findElements(tree, (el) => el.type === Button);

beforeEach(() => {
  resetHooks();
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe('AiKbLearnSwitch', () => {
  it('failed load: Retry and no switch, then the stored value', async () => {
    const fetch = vi.fn<() => Promise<unknown>>(answer(500, {}));
    vi.stubGlobal('fetch', fetch);
    let tree = await drawn();
    expect(switches(tree)).toHaveLength(0);
    expect(JSON.stringify(tree)).toContain('loadFailed');
    fetch.mockImplementation(answer(200, { enabled: true }));
    (buttons(tree)[0]!.props.onClick as () => void)();
    await settle();
    tree = draw();
    expect(buttons(tree)).toHaveLength(0);
    expect(switches(tree)[0]!.props.checked).toBe(true);
  });

  it('a failed save puts the switch back and says so', async () => {
    const fetch = vi.fn<() => Promise<unknown>>(
      answer(200, { enabled: false })
    );
    vi.stubGlobal('fetch', fetch);
    let tree = await drawn();
    fetch.mockImplementation(answer(500, {}));
    (switches(tree)[0]!.props.onCheckedChange as (v: boolean) => void)(true);
    expect(switches(draw())[0]!.props.checked).toBe(true);
    await settle();
    tree = draw();
    expect(switches(tree)[0]!.props).toMatchObject({
      checked: false,
      disabled: false,
    });
    expect(toast.error).toHaveBeenCalledWith('saveFailed');
  });

  it('says why the last run failed and when it tries again', async () => {
    const nextRunAt = new Date(Date.now() + 3_000_000).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn(answer(200, { enabled: true, lastRunError: 'no_ai', nextRunAt }))
    );
    expect(JSON.stringify(await drawn())).toContain('failedNoAi triesAgain');
  });
});
