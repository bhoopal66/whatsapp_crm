import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';

import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';

// The card's layout and its on/off switch. What each figure means is
// lib/insights/customer-view.test.ts.

const mocks = vi.hoisted(() => ({ signalsEnabled: true }));
vi.mock('@/hooks/use-insight-settings', () => ({
  useInsightSettings: () => ({
    settings: { signalsEnabled: mocks.signalsEnabled },
    available: true,
    canEdit: false,
    loading: false,
    reload: vi.fn(),
  }),
}));

import { CustomerInsightsCard } from './customer-insights-card';

type Row = React.ComponentProps<typeof CustomerInsightsCard>['conversation'];

function render(
  conversation: Row,
  {
    tone = 'default',
    messages = en as AbstractIntlMessages,
    locale = 'en',
  }: {
    tone?: 'default' | 'wa';
    messages?: AbstractIntlMessages;
    locale?: string;
  } = {}
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      <CustomerInsightsCard
        conversation={conversation}
        tone={tone}
        frame={(title, body) => (
          <section data-frame>
            <h2>{title}</h2>
            {body}
          </section>
        )}
      />
    </NextIntlClientProvider>
  );
}

const JUDGED: Row = {
  insight_intent: 'business_loan',
  insight_intent_p: 0.82,
  insight_lead_temp: 1.6,
  insight_urgency: 1.6,
  insight_upset: 0.8,
  insight_wants_human: 0.9,
  insight_at: new Date(Date.now() - 5 * 60_000).toISOString(),
};

describe('CustomerInsightsCard', () => {
  it('renders nothing while signals are off', () => {
    mocks.signalsEnabled = false;
    try {
      expect(render(JUDGED)).toBe('');
    } finally {
      mocks.signalsEnabled = true;
    }
  });

  it('shows the empty state in the frame for an unjudged chat', () => {
    for (const row of [null, {}]) {
      const html = render(row);
      expect(html).toContain('data-frame');
      expect(html).toContain('Customer insights');
      expect(html).toContain(
        'No insights yet — they appear after the customer&#x27;s next message'
      );
    }
  });

  it('lays out a judged chat: intent, meter, urgency, mood, time', () => {
    const html = render(JUDGED);
    expect(html).toContain('Business loan');
    expect(html).toContain('82% sure');
    for (const step of [
      'Just curious',
      'Comparing options',
      'Hot lead',
      'Ready to apply',
    ])
      expect(html).toContain(step);
    // Exactly one current step, and it is Hot lead.
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="step"[^>]*>Hot lead</);
    expect(html).toMatch(/text-destructive[^>]*>Urgent</);
    expect(html).toMatch(/text-warning[^>]*>Upset</);
    expect(html).toMatch(/text-info[^>]*>Wants a person</);
    expect(html).not.toContain('Calm');
    expect(html).toContain('Based on their last message · 5 minutes ago');
    expect(html).toContain('bg-card-2');
  });

  it('says Calm only when the upset figure is known', () => {
    expect(render({ insight_upset: 0.1 })).toMatch(/text-success[^>]*>Calm</);
    expect(render({ insight_lead_temp: 0.2 })).not.toContain('Calm');
  });

  it('uses the WhatsApp surfaces in the inbox tone', () => {
    const html = render(JUDGED, { tone: 'wa' });
    expect(html).toContain('bg-wa-search');
    expect(html).not.toContain('bg-card-2');
  });

  it('has Korean words', () => {
    const html = render(JUDGED, {
      messages: ko as AbstractIntlMessages,
      locale: 'ko',
    });
    expect(html).toContain('고객 인사이트');
    expect(html).toContain('확신도 82%');
  });
});
