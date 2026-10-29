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

const can = vi.hoisted(() => ({ send: true }));
vi.mock('@/hooks/use-can', () => ({ useCan: () => can.send }));
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CustomerInsightsCard, TrendLines } from './customer-insights-card';
import { customerInsightView } from '@/lib/insights/customer-view';
import { insightTrends } from '@/lib/insights/trends';

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
  id: 'c1',
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
    // Each step shows its short word on one line; the full band name is
    // its title and its screen-reader text.
    expect(html).toMatch(
      /<li[^>]*aria-current="step"[^>]*title="Hot lead"[^>]*><span aria-hidden="true">Hot<\/span><span class="sr-only">Hot lead<\/span>/
    );
    expect(html).toMatch(
      /<li[^>]*title="Comparing options"[^>]*><span aria-hidden="true">Comparing<\/span>/
    );
    // Palette colours: urgency red, upset fuchsia, wants a person violet,
    // the intent its own hue, the current lead step its band's.
    expect(html).toMatch(/text-red-700[^>]*>Urgent</);
    expect(html).toMatch(/text-fuchsia-700[^>]*>Upset</);
    expect(html).toMatch(/text-violet-700[^>]*>Wants a person</);
    expect(html).toMatch(/text-emerald-700[^>]*>Business loan</);
    expect(html).toMatch(
      /text-orange-700[^"]*font-semibold[^>]*><span aria-hidden="true">Hot</
    );
    expect(html).not.toContain('>Calm<');
    expect(html).toContain('Based on their last message · 5 minutes ago');
    expect(html).toContain('bg-card-2');
    // No pin, no history fetched yet (no trend row), the legend trigger.
    expect(html).not.toContain('Pinned');
    expect(html).not.toContain('Trend');
    expect(html).toContain('What do the colours mean?');
  });

  it('adds sentiment, objections, flags and next best actions', () => {
    const html = render({
      ...JUDGED,
      insight_upset: 0.1,
      insight_wants_human: 0.1,
      insight_sentiment: 0.5,
      insight_objections: ['price', 'trust'],
      insight_needs_reply: 0.9,
      insight_callback: 0.9,
      unread_count: 1,
    });
    expect(html).toMatch(/text-red-700[^>]*>Very negative</);
    expect(html).not.toContain('>Calm<');
    expect(html).toContain('What holds them back');
    expect(html).toMatch(/text-amber-800[^>]*>Price</);
    expect(html).toMatch(/text-rose-700[^>]*>Trust</);
    expect(html).toContain('Waiting for a reply');
    expect(html).toContain('Asked for a call');
    expect(html).toContain('Next best action');
    // call_back, then calm_down (very negative); at most two.
    expect(html).toContain('Call them back');
    expect(html).toContain('They asked for a call');
    expect(html).toContain('Calm things down');
    expect(html).not.toContain('Reply now');
  });

  it('hides objections when there are none', () => {
    expect(render(JUDGED)).not.toContain('What holds them back');
  });

  it('shows the pin with Mark handled for agents, not for viewers', () => {
    const pinned = {
      ...JUDGED,
      insight_attention_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      insight_attention_reason: 'wants_person',
    };
    const html = render(pinned);
    expect(html).toContain('Pinned — Wants a person · 10 minutes ago');
    expect(html).toContain('Mark handled');
    expect(html).toMatch(/role="status"[^>]*bg-violet-50/);
    can.send = false;
    try {
      const viewer = render(pinned);
      expect(viewer).toContain('Pinned — Wants a person');
      expect(viewer).not.toContain('Mark handled');
    } finally {
      can.send = true;
    }
  });

  it('shows the pin beside the empty state', () => {
    const html = render({
      id: 'c1',
      insight_attention_at: new Date(Date.now() - 60_000).toISOString(),
      insight_attention_reason: 'mystery',
    });
    expect(html).toContain('Pinned · 1 minute ago');
    expect(html).toContain('No insights yet');
  });

  it('says Calm only when the upset figure is known', () => {
    expect(render({ insight_upset: 0.1 })).toMatch(/text-slate-700[^>]*>Calm</);
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

describe('TrendLines', () => {
  const at = (i: number) => new Date(Date.UTC(2026, 9, 29, 8, i)).toISOString();
  function lines(figures: Record<string, unknown>[]): string {
    const trends = insightTrends(
      figures.map((f, i) => ({ at: at(i), figures: f }))
    );
    const view = customerInsightView({
      insight_sentiment: 3,
      insight_lead_temp: 0.2,
    });
    return renderToStaticMarkup(
      <NextIntlClientProvider
        locale="en"
        messages={en as AbstractIntlMessages}
        timeZone="UTC"
      >
        <TrendLines view={view} trends={trends} sub="text-muted-foreground" />
      </NextIntlClientProvider>
    );
  }

  it('says there is not enough history below four points', () => {
    const html = lines([{ sentiment: 1 }, { sentiment: 2 }, { sentiment: 3 }]);
    expect(html).toContain('Not enough history yet');
    expect(html).not.toContain('<svg');
  });

  it('draws a labelled line per scale with enough points, in its colour', () => {
    const html = lines([
      { sentiment: 0, leadTemp: 2 },
      { sentiment: 1, leadTemp: 2 },
      { sentiment: 3, leadTemp: 2 },
      { sentiment: 4, leadTemp: 2 },
    ]);
    expect(html.match(/<svg/g)).toHaveLength(2);
    expect(html).toContain(
      'aria-label="Mood over the last 4 messages: Improving"'
    );
    expect(html).toContain(
      'aria-label="Lead over the last 4 messages: Steady"'
    );
    expect(html).toContain('stroke="currentColor"');
    // Sentiment 3 is positive (teal); lead 0.2 is cold (slate).
    expect(html).toMatch(/text-teal-700[^"]*"[^>]*><path/);
    expect(html).toMatch(/text-slate-600[^"]*"[^>]*><path/);
  });

  it('leaves out a scale with too few values', () => {
    const html = lines([
      { sentiment: 1 },
      { sentiment: 1 },
      { sentiment: 1, leadTemp: 1 },
      { sentiment: 1 },
    ]);
    expect(html.match(/<svg/g)).toHaveLength(1);
    expect(html).toContain('Mood over the last 4 messages: Steady');
  });
});
