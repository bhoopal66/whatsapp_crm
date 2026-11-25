import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';

import en from '../../../../messages/en.json';

// The Smart insights tiles of "Needs your attention": shown and read only
// while signals are on, linking to the matching inbox filter, counting
// with customer-view.ts's bounds.

const mocks = vi.hoisted(() => ({
  signalsEnabled: true,
  keys: [] as (string | null)[],
  loaders: new Map<string, () => Promise<unknown>>(),
  ops: [] as unknown[][][],
}));

vi.mock('@/hooks/use-insight-settings', () => ({
  useInsightSettings: () => ({
    settings: { signalsEnabled: mocks.signalsEnabled },
  }),
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'acc', accountRole: 'agent' }),
}));
vi.mock('@/hooks/use-ai-auto-reply-live', () => ({
  useAiAutoReplyLive: () => false,
}));
vi.mock('./use-widget-data', () => ({
  useWidgetData: (key: string | null, load: () => Promise<unknown>) => {
    mocks.keys.push(key);
    if (key) mocks.loaders.set(key.split(':')[0], load);
    const data = key?.startsWith('attention-insights')
      ? {
          rows: [
            { unread_count: 1, insight_lead_temp: 2 },
            { unread_count: 1, insight_lead_temp: 2 },
            { unread_count: 1, insight_lead_temp: 1.5 },
          ],
          truncated: false,
        }
      : null;
    return { data, loading: false, error: false, reload() {}, update() {} };
  },
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => {
      const ops: unknown[][] = [];
      mocks.ops.push(ops);
      const q = {
        select: (...a: unknown[]) => (ops.push(['select', ...a]), q),
        or: (...a: unknown[]) => (ops.push(['or', ...a]), q),
        gt: (...a: unknown[]) => (ops.push(['gt', ...a]), q),
        order: (...a: unknown[]) => (ops.push(['order', ...a]), q),
        range: (...a: unknown[]) => (ops.push(['range', ...a]), q),
        then: (resolve: (r: unknown) => void) =>
          resolve({ data: [{ id: 'a' }], error: null }),
      };
      return q;
    },
  }),
}));

import { AttentionStrip } from './attention-strip';

function render(
  missedCalls: ComponentProps<typeof AttentionStrip>['missedCalls'] = null
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={en as AbstractIntlMessages}
      timeZone="UTC"
    >
      <AttentionStrip
        refreshKey={0}
        tasks={null}
        cases={null}
        missedCalls={missedCalls}
      />
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  mocks.signalsEnabled = true;
  mocks.keys = [];
  mocks.loaders.clear();
  mocks.ops = [];
});

describe('AttentionStrip Smart insights tiles', () => {
  it('leaves the tiles out, and reads nothing, while signals are off', () => {
    mocks.signalsEnabled = false;
    const html = render();
    expect(html).not.toContain('Hot leads waiting');
    expect(html).not.toContain('Upset customers waiting');
    expect(mocks.keys.some((k) => k?.startsWith('attention-insights'))).toBe(
      false
    );
  });

  it('shows both tiles linking to the inbox filters', () => {
    const html = render();
    expect(html).toContain('Hot leads waiting');
    expect(html).toContain('href="/inbox?insight=hot&amp;filter=unread"');
    expect(html).toMatch(/text-success[^>]*>3</);
    expect(html).toContain('Upset customers waiting');
    expect(html).toContain('href="/inbox?insight=upset&amp;filter=unread"');
  });

  it('reads unread hot-or-upset chats in one query', async () => {
    render();
    const load = mocks.loaders.get('attention-insights');
    expect(load).toBeDefined();
    await expect(load!()).resolves.toEqual({
      rows: [{ id: 'a' }],
      truncated: false,
    });
    const [q] = mocks.ops;
    expect(q).toContainEqual(['gt', 'unread_count', 0]);
    expect(q).toContainEqual(['order', 'id']);
    expect(q).toContainEqual(['range', 0, 999]);
    expect(q).toContainEqual([
      'or',
      'insight_lead_temp.gte.1.4,insight_upset.gte.0.7',
    ]);
  });
});

describe('the missed calls tile', () => {
  const tile = (missedCalls: Parameters<typeof render>[0]) =>
    render(missedCalls)
      .split('<a ')
      .find((a) => a.includes('href="/calls"')) ?? '';

  it('could not be counted: a dash, never "All clear"', () => {
    const html = tile({ count: null, error: true });
    expect(html).toContain('–');
    expect(html).not.toContain(en.Dashboard.home.attention.allClear);
  });

  it('not counted yet: neither a figure nor "All clear"', () => {
    const html = tile({ count: null, error: false });
    expect(html).not.toContain('–');
    expect(html).not.toContain(en.Dashboard.home.attention.allClear);
  });

  it('none is "All clear"', () => {
    expect(tile({ count: 0, error: false })).toContain(
      en.Dashboard.home.attention.allClear
    );
  });
});
