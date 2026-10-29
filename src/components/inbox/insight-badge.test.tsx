import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';

import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';
import { InsightBadge } from './insight-badge';

// The words and tone the row badge renders. Which badge a row gets is
// lib/inbox/insights.test.ts.

type Row = React.ComponentProps<typeof InsightBadge>['conversation'];

const BLANK: Row = {};

function render(
  over: Row,
  messages: AbstractIntlMessages = en as AbstractIntlMessages,
  locale = 'en'
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <InsightBadge conversation={{ ...BLANK, ...over }} />
    </NextIntlClientProvider>
  );
}

describe('InsightBadge', () => {
  it('renders nothing for an unjudged or calm chat', () => {
    expect(render({})).toBe('');
    expect(render({ insight_lead_temp: 0.2, insight_upset: 0.1 })).toBe('');
  });

  it('renders the badge as a span (the row is a button), never a button', () => {
    const html = render({ insight_priority: 2 });
    expect(html).toContain('Urgent');
    expect(html).toContain('text-destructive');
    expect(html.startsWith('<span')).toBe(true);
    expect(html).not.toContain('<button');
  });

  it('labels each kind with its tone', () => {
    expect(render({ insight_upset: 0.8 })).toMatch(/text-warning.*Upset/);
    expect(render({ insight_wants_human: 0.85 })).toMatch(
      /text-info.*Wants a person/
    );
    const hot = render({ insight_lead_temp: 1.6 });
    expect(hot).toMatch(/text-success/);
    expect(hot).toContain('Hot lead');
    expect(hot).toContain('<svg');
    expect(render({ insight_lead_temp: 2.5 })).toContain('Ready to apply');
  });

  it('has Korean words for every badge', () => {
    const html = render(
      { insight_priority: 2 },
      ko as AbstractIntlMessages,
      'ko'
    );
    expect(html).toContain('긴급');
  });
});
