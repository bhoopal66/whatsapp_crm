import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';

import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';
import { ComposeCheckWarningList } from './compose-check-dialog';
import { ComposeCheckStatsView } from '../settings/compose-check-stats';
import {
  COMPOSE_CHECK_CODES_BY_SEVERITY,
  type ComposeCheckStats,
} from '@/lib/insights/compose-check-view';

function render(
  node: React.ReactNode,
  messages: AbstractIntlMessages = en as AbstractIntlMessages
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>
  );
}

describe('ComposeCheckWarningList', () => {
  it('words every code in plain language, in both catalogues', () => {
    for (const messages of [en, ko] as AbstractIntlMessages[]) {
      const html = render(
        <ComposeCheckWarningList warnings={COMPOSE_CHECK_CODES_BY_SEVERITY} />,
        messages
      );
      expect(html.match(/<li/g)?.length).toBe(7);
      expect(html).not.toContain('ComposeCheck.');
    }
  });

  it('marks secrets destructive and the rest warning, never .dark', () => {
    const html = render(
      <ComposeCheckWarningList warnings={['secrets', 'promise']} />
    );
    expect(html).toContain('Never ask for these in chat.');
    expect(html).toContain('Only the bank can decide.');
    expect(html).toContain('bg-destructive-soft');
    expect(html).toContain('bg-warning-soft');
    expect(html).not.toMatch(/\bdark:/);
  });
});

describe('ComposeCheckStatsView', () => {
  const stats: ComposeCheckStats = {
    days: 7,
    total: 12,
    sentAnyway: 4,
    edited: 7,
    pending: 1,
    byCode: { tone: 6, promise: 3, terms: 2, secrets: 1 },
  };

  it('shows totals and the top three codes', () => {
    const html = render(<ComposeCheckStatsView stats={stats} />);
    expect(html).toContain('Last 7 days');
    expect(html).toContain('12 warnings, 4 sent anyway, 7 edited');
    expect(html).toContain(
      'Most common: Tone (6), Promises an approval or timeline (3), Quotes a rate, fee or amount (2)'
    );
    expect(html).not.toContain('card details');
  });

  it('is hidden with no warnings or no answer', () => {
    expect(render(<ComposeCheckStatsView stats={null} />)).toBe('');
    expect(
      render(<ComposeCheckStatsView stats={{ ...stats, total: 0 }} />)
    ).toBe('');
  });
});
