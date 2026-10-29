import { beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';

import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';
import {
  PALETTE_FAMILIES,
  PALETTE_KEYS,
  paletteFor,
} from '@/lib/insights/palette';

// base-ui's popover portal does not server-render; stand it in with a
// closed popover (the trigger only), which is all a static render shows.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => (
    <button type="button" className={className}>
      {children}
    </button>
  ),
  PopoverContent: () => null,
  PopoverTitle: () => null,
}));

import { InsightLegend, InsightLegendContent } from './insight-legend';

// The legend's words and colours. Which colour each value has is
// lib/insights/palette.test.ts.

function render(
  node: React.ReactNode,
  messages: AbstractIntlMessages = en as AbstractIntlMessages,
  locale = 'en'
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages}>
      {node}
    </NextIntlClientProvider>
  );
}

describe('InsightLegend', () => {
  it('renders a closed popover: just the trigger button', () => {
    const html = render(<InsightLegend />);
    expect(html).toContain('What do the colours mean?');
    expect(html).toContain('<button');
    expect(html).not.toContain('Needs a person');
  });
});

describe('InsightLegendContent', () => {
  let html = '';
  beforeAll(() => {
    html = render(<InsightLegendContent />);
  });

  it('has one section per family, in display order', () => {
    const titles = PALETTE_FAMILIES.map(
      (f) => en.InsightsUi.legend.families[f].title
    );
    expect((html.match(/<section/g) ?? []).length).toBe(titles.length);
    let last = -1;
    for (const title of titles) {
      const i = html.indexOf(`>${title}</h3>`);
      expect(i, title).toBeGreaterThan(last);
      last = i;
    }
  });

  it('shows every value as its chip and a one-line meaning', () => {
    for (const family of PALETTE_FAMILIES) {
      const items = en.InsightsUi.legend.families[family].items as Record<
        string,
        { label: string; meaning: string }
      >;
      for (const key of PALETTE_KEYS[family]) {
        const { label, meaning } = items[key];
        const chip = paletteFor(family, key as never).chip;
        expect(html, `${family}.${key}`).toContain(
          `${chip}">${label.replace(/'/g, '&#x27;')}</span>`
        );
        expect(html, `${family}.${key}`).toContain(
          meaning.replace(/'/g, '&#x27;')
        );
      }
    }
  });

  it('has Korean words for every value', () => {
    const koHtml = render(
      <InsightLegendContent />,
      ko as AbstractIntlMessages,
      'ko'
    );
    expect(koHtml).toContain('상담원 필요');
    expect(koHtml).toContain('회신 전화');
  });
});
