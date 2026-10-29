import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
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
      ? { hotWaiting: 3, upsetToday: 0 }
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
        gte: (...a: unknown[]) => (ops.push(['gte', ...a]), q),
        gt: (...a: unknown[]) => (ops.push(['gt', ...a]), q),
        then: (resolve: (r: unknown) => void) =>
          resolve({ count: 2, error: null }),
      };
      return q;
    },
  }),
}));

import { AttentionStrip } from './attention-strip';

function render(): string {
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
        missedCalls={null}
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
    expect(html).not.toContain('Upset customers today');
    expect(mocks.keys.some((k) => k?.startsWith('attention-insights'))).toBe(
      false
    );
  });

  it('shows both tiles linking to the inbox filters', () => {
    const html = render();
    expect(html).toContain('Hot leads waiting');
    expect(html).toContain('href="/inbox?insight=hot"');
    expect(html).toMatch(/text-success[^>]*>3</);
    expect(html).toContain('Upset customers today');
    expect(html).toContain('href="/inbox?insight=upset"');
  });

  it('counts with the hot-lead and upset-today bounds', async () => {
    render();
    const load = mocks.loaders.get('attention-insights');
    expect(load).toBeDefined();
    await expect(load!()).resolves.toEqual({ hotWaiting: 2, upsetToday: 2 });
    const [hot, upset] = mocks.ops;
    expect(hot).toContainEqual(['gte', 'insight_lead_temp', 1.4]);
    expect(hot).toContainEqual(['gt', 'unread_count', 0]);
    expect(upset).toContainEqual(['gte', 'insight_upset', 0.7]);
    const at = upset.find((o) => o[1] === 'insight_at');
    expect(at?.[0]).toBe('gte');
    const since = Date.parse(at?.[2] as string);
    expect(Date.now() - since).toBeGreaterThanOrEqual(0);
    expect(Date.now() - since).toBeLessThan(25 * 3600_000);
  });
});
