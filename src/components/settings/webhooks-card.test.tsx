import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

// Settings → API keys: the Webhooks card and the revoke question (315).
vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('next-intl', () => {
  const t = Object.assign(
    (k: string, v?: object) => (v ? `${k}:${JSON.stringify(v)}` : k),
    { rich: (k: string) => k }
  );
  const format = {
    dateTime: (d: Date, o: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat('en-GB', o).format(d),
  };
  return { useTranslations: () => t, useFormatter: () => format };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from 'sonner';

import { ErrorState } from '@/components/dashboard/error-state';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { findElements, render, resetHooks, settle } from '@/test/hook-renderer';
import type { AccountWebhook } from '@/lib/webhooks/account-list';

import { ApiKeysSettings } from './api-keys-settings';
import { WebhooksCard } from './webhooks-card';

const KEY = {
  id: 'k-1',
  name: 'Zapier',
  key_prefix: 'taamul_live_ab',
  scopes: [],
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
  created_at: '2026-11-01T08:00:00Z',
};
const webhook = (over: Partial<AccountWebhook>): AccountWebhook => ({
  id: 'w-1',
  host: 'hooks.example.com',
  events: ['message.received'],
  is_active: true,
  last_delivery_at: '2026-11-24T21:30:00Z',
  failure_count: 0,
  first_failure_at: null,
  created_at: '2026-11-01T08:00:00Z',
  key: { id: 'k-1', name: 'Zapier', status: 'active' },
  ...over,
});

type Reply = { status: number; body: unknown } | Error | 'never';
let list: Reply;
let keys: Reply;
let change: Reply;
let calls: string[];
const ready = (...webhooks: AccountWebhook[]): Reply => ({
  status: 200,
  body: { webhooks },
});

beforeEach(() => {
  resetHooks();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  list = ready();
  keys = { status: 200, body: { keys: [KEY] } };
  change = { status: 200, body: { success: true } };
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url} ${init?.body ?? ''}`.trim());
    let reply: Reply = keys;
    if (method !== 'GET') reply = change;
    else if (url === '/api/account/webhooks') reply = list;
    if (reply === 'never') return new Promise(() => {});
    if (reply instanceof Error) throw reply;
    const { status, body } = reply;
    return { ok: status < 300, status, json: async () => body };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The screen with the card rendered in it. */
const screen = () =>
  render(() => {
    const page = ApiKeysSettings();
    const card = findElements(page, (el) => el.type === WebhooksCard)[0];
    return (
      <>
        {page}
        {card && WebhooksCard(card.props as never)}
      </>
    );
  });
async function load() {
  screen();
  await settle();
  return screen();
}

const textOf = (node: ReactNode): string => {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node)
    return textOf((node.props as { children?: ReactNode }).children);
  return typeof node === 'string' ? node : '';
};
const errors = (tree: ReactNode) =>
  findElements(tree, (el) => el.type === ErrorState);
const statuses = (tree: ReactNode) =>
  findElements(tree, (el) => el.props.role === 'status');
const openDialog = () =>
  findElements(
    screen(),
    (el) => el.type === ConfirmDialog && el.props.open === true
  )[0];
const listReads = () =>
  calls.filter((c) => c === 'GET /api/account/webhooks').length;

function press(label: string) {
  const button = findElements(
    screen(),
    (el) => !!el.props.onClick && textOf(el) === label
  )[0];
  (button.props.onClick as () => void)();
}
async function confirm() {
  (openDialog().props.onConfirm as () => void)();
  await settle();
}

describe('the keys', () => {
  it('a failed read is an error with Retry, never "no keys"', async () => {
    keys = { status: 500, body: null };
    const failed = errors(await load()).find(
      (el) => el.props.message === 'loadFailed'
    )!;
    expect(textOf(screen())).not.toContain('noApiKeys');
    keys = { status: 200, body: { keys: [KEY] } };
    (failed.props.onRetry as () => void)();
    const tree = await load();
    expect(errors(tree)).toHaveLength(0);
    expect(textOf(tree)).toContain('Zapier');
  });
});

describe('the card', () => {
  it('shows loading until the answer, not "No webhooks"', async () => {
    list = 'never';
    const tree = await load();
    expect(statuses(tree)).toHaveLength(1);
    expect(textOf(tree)).not.toContain('noWebhooks');
    expect(errors(tree)).toHaveLength(0);
  });

  it('says when there are none', async () => {
    const tree = await load();
    expect(textOf(tree)).toContain('noWebhooks');
    expect(errors(tree)).toHaveLength(0);
    expect(statuses(tree)).toHaveLength(0);
  });

  it.each<[string, Reply]>([
    ['a server error', { status: 500, body: { error: 'no' } }],
    ['offline', new Error('offline')],
    ['an answer without a list', { status: 200, body: {} }],
  ])('%s is an error with Retry, never "No webhooks"', async (_name, reply) => {
    list = reply;
    const tree = await load();
    expect(errors(tree)).toHaveLength(1);
    expect(textOf(tree)).not.toContain('noWebhooks');

    list = ready(webhook({}));
    (errors(tree)[0].props.onRetry as () => void)();
    expect(statuses(screen())).toHaveLength(1);
    await settle();
    expect(errors(screen())).toHaveLength(0);
    expect(textOf(screen())).toContain('hooks.example.com');
  });

  it('shows host, events, key, state, failures and Dubai times', async () => {
    list = ready(
      webhook({}),
      webhook({
        id: 'w-2',
        host: 'old.example.com',
        is_active: false,
        last_delivery_at: null,
        failure_count: 7,
        first_failure_at: '2026-11-23T22:00:00Z',
        key: null,
      }),
      webhook({
        id: 'w-3',
        host: null,
        key: { id: 'k-2', name: 'Old key', status: 'revoked' },
      })
    );
    const rows = findElements(await load(), (el) => el.type === 'li')
      .map(textOf)
      .filter((row) => row.includes('webhook'));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('hooks.example.com');
    expect(rows[0]).toContain('message.received');
    expect(rows[0]).toContain('webhookOn');
    expect(rows[0]).toContain('webhookKey:{"name":"Zapier"}');
    expect(rows[0]).toContain('25 Nov 2026, 01:30');
    expect(rows[0]).toContain('webhookSwitchOff');
    expect(rows[0]).not.toContain('webhookFailing');
    expect(rows[1]).toContain('webhookNoKey');
    expect(rows[1]).toContain('24 Nov 2026, 02:00","count":7');
    expect(rows[1]).toContain('webhookNeverDelivered');
    expect(rows[1]).not.toContain('webhookSwitchOff');
    expect(rows[1]).toContain('webhookDelete');
    expect(rows[2]).toContain('webhookUnknownHost');
    expect(rows[2]).toContain('"Old key"} (revoked)');
  });

  it('switches off after a question, then reads the list again', async () => {
    list = ready(webhook({}));
    await load();
    press('webhookSwitchOff');
    expect(openDialog().props.description).toContain('hooks.example.com');
    expect(listReads()).toBe(1);
    list = ready(webhook({ is_active: false }));
    await confirm();
    expect(calls).toContain(
      'PATCH /api/account/webhooks/w-1 {"is_active":false}'
    );
    expect(listReads()).toBe(2);
    expect(openDialog()).toBeUndefined();
    expect(textOf(screen())).toContain('webhookOff');
    expect(textOf(screen())).not.toContain('webhookSwitchOff');
  });

  it('a delete names the host', async () => {
    list = ready(webhook({}));
    await load();
    press('webhookDelete');
    expect(openDialog().props.title).toBe('webhookDeleteTitle');
    expect(openDialog().props.description).toContain('hooks.example.com');
    list = ready();
    await confirm();
    expect(calls).toContain('DELETE /api/account/webhooks/w-1');
    expect(textOf(screen())).toContain('noWebhooks');
  });

  it('a refused change says so and reads the list again', async () => {
    list = ready(webhook({}));
    await load();
    press('webhookDelete');
    change = { status: 404, body: { error: 'Webhook not found' } };
    await confirm();
    expect(toast.error).toHaveBeenCalledWith('webhookDeleteFailed');
    expect(toast.success).not.toHaveBeenCalled();
    expect(listReads()).toBe(2);
  });
});

describe('revoking a key', () => {
  it('asks first, counts its switched-on webhooks and reloads the card', async () => {
    list = ready(
      webhook({ id: 'w-1' }),
      webhook({ id: 'w-2' }),
      webhook({ id: 'w-3', is_active: false }),
      webhook({ id: 'w-4', key: null }),
      webhook({ id: 'w-5', key: { id: 'k-2', name: 'B', status: 'active' } })
    );
    await load();
    press('revoke');
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    expect(openDialog().props.description).toBe(
      'revokeBody:{"name":"Zapier"} revokeStopsWebhooks:{"count":2}'
    );
    list = ready(webhook({ is_active: false, host: 'after.example.com' }));
    await confirm();
    await settle();
    expect(calls).toContain('DELETE /api/account/api-keys/k-1');
    expect(listReads()).toBe(2);
    expect(textOf(screen())).toContain('after.example.com');
  });

  it('a refused revoke does not reload the card', async () => {
    await load();
    press('revoke');
    change = { status: 500, body: {} };
    await confirm();
    expect(listReads()).toBe(1);
  });

  it.each<[string, Reply]>([
    ['could not be loaded', { status: 500, body: {} }],
    ['is still loading', 'never'],
  ])('says nothing about webhooks when the list %s', async (_name, reply) => {
    list = reply;
    await load();
    press('revoke');
    expect(openDialog().props.description).toBe('revokeBody:{"name":"Zapier"}');
  });

  it('a read begun before the revoke does not put the old list back', async () => {
    const pending: ((v: unknown) => void)[] = [];
    const answer = (host: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ webhooks: [webhook({ host })] }),
    });
    const base = globalThis.fetch as (
      url: string,
      init?: RequestInit
    ) => Promise<unknown>;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
      url === '/api/account/webhooks'
        ? new Promise((resolve) => pending.push(resolve))
        : base(url, init)
    );
    await load();
    press('revoke');
    await confirm();
    pending[1](answer('new.example.com'));
    await settle();
    pending[0](answer('old.example.com'));
    await settle();
    expect(textOf(screen())).toContain('new.example.com');
  });
});
