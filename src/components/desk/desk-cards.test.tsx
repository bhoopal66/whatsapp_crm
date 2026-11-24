import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

// Settings saved against the version the card loaded (316); a failed read
// offers Retry; the consent and leave forms act once, on what was shown.
vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('next-intl', () => ({
  useTranslations: () => (k: string, v?: Record<string, unknown>) =>
    v ? `${k}:${JSON.stringify(v)}` : k,
  useLocale: () => 'en',
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const api = vi.hoisted(
  () =>
    new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
      get: (o, k: string) => (o[k] ??= vi.fn()),
    })
);
vi.mock('./desk-api', () => ({ deskApi: api }));

import { ChangedNotice } from '@/components/settings/case-files-settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { findElements, render, resetHooks, settle } from '@/test/hook-renderer';

import { CompanyPeople } from './companies-tab';
import { CompanyBanks, ConsentRow } from './company-banks';
import { CoverCard, CoverRolesEditor, HolderLeave } from './cover-card';
import { DigestSettings } from './digest-settings';
import { LoadFailed } from './load-failed';
import { RoutingSettings } from './routing-settings';

const ok = (data: unknown) => ({ ok: true, data });
const no = (code: string | null = null) => ({ ok: false, code, error: 'e' });

beforeEach(() => {
  resetHooks();
  for (const k of Object.keys(api)) api[k].mockReset();
});

async function load(view: () => ReactNode) {
  render(view);
  await settle();
  return render(view);
}
const of = (view: () => ReactNode, type: unknown) =>
  findElements(render(view), (el) => el.type === type);
async function press(view: () => ReactNode, index = -1) {
  (of(view, Button).at(index)!.props.onClick as () => void)();
  await settle();
}

const digest = (over: object) => ({
  enabled: true,
  templateName: 't',
  language: 'en',
  sendHour: 10,
  gapDays: 2,
  updatedAt: 'v1',
  ...over,
});
const routing = (over: object) => ({
  settings: {
    routingEnabled: true,
    deskChannelIds: ['n-1'],
    escalateMinutes: 120,
    updatedAt: 'v1',
    ...over,
  },
  numbers: [{ id: 'n-1', label: 'Desk' }],
});

describe.each([
  {
    name: 'the digest card',
    view: DigestSettings,
    get: 'digest',
    save: 'saveDigest',
    first: digest({}),
    off: digest({ enabled: false, updatedAt: 'v2' }),
    sent: () => api.saveDigest.mock.lastCall![0].updatedAt,
  },
  {
    name: 'the routing card',
    view: RoutingSettings,
    get: 'settings',
    save: 'saveSettings',
    first: routing({}),
    off: routing({ routingEnabled: false, updatedAt: 'v2' }),
    sent: () => api.saveSettings.mock.lastCall![0].expectedUpdatedAt,
  },
])('$name', ({ view, get, save, first, off, sent }) => {
  const box = () =>
    findElements(render(view), (el) => el.props.type === 'checkbox')[0].props
      .checked;

  it('over another save: shows the stored values, keeps the form until Reload', async () => {
    api[get].mockResolvedValue(ok(first));
    await load(view);
    api[get].mockResolvedValue(ok(off));
    api[save].mockResolvedValue(no('SETTINGS_CHANGED'));
    await press(view);
    expect(sent()).toBe('v1');
    expect(box()).toBe(true);
    const notice = of(view, ChangedNotice)[0];
    expect(notice.props.text).toContain('"enabled":"no"');
    expect(of(view, Button).at(-1)!.props.disabled).toBe(true);
    await (notice.props.onReload as () => Promise<void>)();
    expect(box()).toBe(false);
    expect(of(view, ChangedNotice)).toHaveLength(0);
    api[save].mockResolvedValue(ok('v3'));
    await press(view);
    expect(sent()).toBe('v2');
    // Its own save is the version it names next.
    await press(view);
    expect(sent()).toBe('v3');
  });

  it('a Reload that fails keeps the form and the notice', async () => {
    api[get].mockResolvedValue(ok(first));
    await load(view);
    api[get].mockResolvedValue(no());
    api[save].mockResolvedValue(no('SETTINGS_CHANGED'));
    await press(view);
    const notice = of(view, ChangedNotice)[0];
    expect(notice.props.text).not.toContain('storedNow');
    await (notice.props.onReload as () => Promise<void>)();
    expect(box()).toBe(true);
    expect(of(view, ChangedNotice)).toHaveLength(1);
  });

  it('a failed first load offers Retry', async () => {
    api[get].mockResolvedValue(no());
    await load(view);
    api[get].mockResolvedValue(ok(first));
    await (of(view, LoadFailed)[0].props.onRetry as () => Promise<void>)();
    expect(box()).toBe(true);
  });
});

const company = {
  customerId: 'c-1',
  legalName: 'Acme',
  canManage: true,
} as never;

describe('a failed read offers Retry', () => {
  it.each([
    ['cover', CoverCard],
    ['roles', CoverRolesEditor],
  ])('%s', async (_n, view) => {
    api.cover.mockResolvedValue(no());
    const missing = (await load(view)) as React.ReactElement<{
      failed: boolean;
      onRetry: () => Promise<void>;
    }>;
    expect(missing.props.failed).toBe(true);
    expect(
      findElements(
        (missing.type as (p: object) => ReactNode)(missing.props),
        (el) => el.type === LoadFailed
      )
    ).toHaveLength(1);
    api.cover.mockResolvedValue(ok([]));
    await missing.props.onRetry();
    const card = findElements(render(view), () => true);
    expect(card.some((el) => el.props.children === 'cover.noBanks')).toBe(true);
  });

  it('the people and the checklist of a company', async () => {
    api.companyContacts.mockResolvedValue(no());
    const people = () => CompanyPeople({ company, onChanged: () => {} });
    await load(people);
    expect(of(people, LoadFailed)).toHaveLength(1);
    expect(
      findElements(
        render(people),
        (el) => el.props.children === 'companies.noPeople'
      )
    ).toHaveLength(0);

    resetHooks();
    api.companyOverview.mockResolvedValue(
      ok({ cases: [], consents: [], files: [] })
    );
    api.checklist.mockResolvedValue(no());
    const banks = () => CompanyBanks({ company });
    await load(banks);
    expect(of(banks, LoadFailed)).toHaveLength(1);
  });
});

describe('the consent row', () => {
  const row = (consents: object[]) =>
    findElements(
      render(() =>
        ConsentRow({
          bank: 'ADCB',
          company,
          overview: { consents } as never,
          onChanged: async () => {},
        })
      ),
      () => true
    );
  const grant = {
    bankCode: 'ADCB',
    evidence: 'call',
    grantedAt: '2026-11-23T21:30:00+00:00',
    revokedAt: null,
  };
  const key = (els: ReturnType<typeof row>) =>
    els.find((el) => el.props.customerId === 'c-1')!.key;

  it('typed evidence never becomes a revoke reason', () => {
    const before = key(row([]));
    const after = key(row([grant]));
    expect(before).not.toBe(after);
    expect(key(row([grant]))).toBe(after);
  });

  it('shows the Dubai day of the consent', () => {
    const text = row([grant]).map((el) => String(el.props.children));
    expect(text.join()).toContain('"date":"2026-11-24"');
  });
});

describe('the leave form', () => {
  const onDone = vi.fn(async () => {});
  const view = () =>
    HolderLeave({
      holder: { userId: 'u-1', name: 'A', onLeave: false, leave: [] } as never,
      onDone,
    });
  const type = () => {
    for (const i of [0, 1])
      (of(view, Input)[i].props.onChange as (e: object) => void)({
        target: { value: '2026-11-25' },
      });
  };
  const dates = () => of(view, Input).map((el) => el.props.value);

  it('keeps the dates after a failed save and clears them after a good one', async () => {
    type();
    api.addLeave.mockResolvedValue(no());
    await press(view);
    expect(dates()).toEqual(['2026-11-25', '2026-11-25']);
    api.addLeave.mockResolvedValue(ok(true));
    await press(view);
    expect(dates()).toEqual(['', '']);
  });

  it('a double click records the leave once', async () => {
    type();
    api.addLeave.mockResolvedValue(ok(true));
    const click = of(view, Button).at(-1)!.props.onClick as () => void;
    click();
    click();
    await settle();
    expect(api.addLeave).toHaveBeenCalledTimes(1);
  });
});
