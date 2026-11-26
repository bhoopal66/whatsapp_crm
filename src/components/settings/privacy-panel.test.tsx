import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('next-intl', () => {
  const t = (k: string) => k;
  return { useTranslations: () => t, useFormatter: () => ({}) };
});
vi.mock('@/components/pipelines/contact-picker', () => ({
  ContactPicker: () => null,
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from 'sonner';

import { ErrorState } from '@/components/dashboard/error-state';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { findElements, render, resetHooks, settle } from '@/test/hook-renderer';
import { PrivacyPanel } from './privacy-panel';

type Handler = (...args: unknown[]) => void;
const [, Retention, AiTransfer] = (
  PrivacyPanel().props.children as { type: () => ReactNode }[]
).map((el) => el.type);

const BASIS = {
  basis: {
    basis: 'scc',
    note: 'Standard clauses signed in May.',
    approved_by: 'Legal',
    provider_region: 'US',
    require_basis: true,
    recorded_at: 'v1',
  },
  last_30_days: {},
  refused_30_days: 0,
};
const POLICY = {
  policy: { tables: { call_records: { days: 400, action: 'anonymise' } } },
  apply: false,
  updatedAt: 'v1',
  lastRun: null,
};

const fetchMock = vi.fn();
const answer = (status: number, body: object) => async () =>
  Response.json(body, { status });
const all = (C: () => ReactNode, type: unknown) =>
  findElements(render(C), (el) => el.type === type);
const byProp = (C: () => ReactNode, prop: string, value: string) =>
  findElements(render(C), (el) => el.props[prop] === value)[0];
const press = async (C: () => ReactNode, label: string) => {
  const b = all(C, Button).find((el) => el.props.children === label)!;
  (b.props.onClick as Handler)();
  await settle();
};
const puts = () =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'PUT')
    .map(([, init]) => JSON.parse(String(init.body)));

async function open(C: () => ReactNode) {
  render(C);
  await settle();
}

beforeEach(() => {
  resetHooks();
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe.each([
  ['Retention', Retention, POLICY],
  ['AiTransfer', AiTransfer, BASIS],
])('%s', (_name, C, stored) => {
  it('a failed load shows an error with Retry and nothing to save', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    fetchMock.mockImplementation(answer(200, stored));
    await open(C);
    expect(all(C, Button)).toHaveLength(0);
    expect(all(C, Switch)).toHaveLength(0);
    const [error] = all(C, ErrorState);
    expect(error.props.message).toBe('errors.network');
    (error.props.onRetry as Handler)();
    await settle();
    expect(all(C, ErrorState)).toHaveLength(0);
    expect(all(C, Switch).length).toBeGreaterThan(0);
  });

  it('a 409 keeps what was typed; only Reload replaces it', async () => {
    fetchMock.mockImplementation(answer(200, stored));
    await open(C);
    const value = () => all(C, Input)[0].props.value;
    const before = value();
    (all(C, Input)[0].props.onChange as Handler)({ target: { value: '77' } });
    fetchMock.mockImplementation(answer(409, { error: 'x', code: 'STALE' }));
    await press(C, 'save');
    expect(puts()).toHaveLength(1);
    expect(puts()[0].expectedUpdatedAt).toBe('v1');
    expect(value()).toBe('77');
    const [text, opts] = vi.mocked(toast.error).mock.calls[0];
    expect(text).toBe('errors.STALE');
    fetchMock.mockImplementation(answer(200, stored));
    (opts!.action as { onClick: Handler }).onClick();
    await settle();
    expect(value()).toBe(before);
  });
});

describe('Retention apply', () => {
  const turnOn = async () => {
    await open(Retention);
    (
      byProp(Retention, 'aria-label', 'retention.apply').props
        .onCheckedChange as Handler
    )(true);
    await press(Retention, 'save');
  };

  it('turning it on asks first, naming what is deleted', async () => {
    fetchMock.mockImplementation(answer(200, POLICY));
    await turnOn();
    expect(puts()).toHaveLength(0);
    expect(all(Retention, Dialog)[0].props.open).toBe(true);
    const items = findElements(render(Retention), (el) => el.type === 'li');
    expect(items.map((el) => el.key)).toEqual(['call_records']);
    await press(Retention, 'retention.confirm');
    expect(puts()).toEqual([
      { policy: POLICY.policy, apply: true, expectedUpdatedAt: 'v1' },
    ]);
  });

  it('already on: no question', async () => {
    fetchMock.mockImplementation(answer(200, { ...POLICY, apply: true }));
    await open(Retention);
    await press(Retention, 'save');
    expect(puts()).toHaveLength(1);
  });
});
