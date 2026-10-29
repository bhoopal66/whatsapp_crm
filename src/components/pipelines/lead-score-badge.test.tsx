import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';

import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';
import type { LeadScore } from '@/lib/pipelines/lead-score';
import { LeadScoreBadge } from './lead-score-badge';

const BASE: LeadScore = {
  score: 84,
  band: 'hot',
  basis: 'insights',
  reasons: ['ready_to_apply'],
  atRisk: false,
};

function render(
  over: Partial<LeadScore> = {},
  messages: AbstractIntlMessages = en as AbstractIntlMessages,
  locale = 'en'
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <LeadScoreBadge score={{ ...BASE, ...over }} />
    </NextIntlClientProvider>
  );
}

describe('LeadScoreBadge', () => {
  it('reads "84 · Hot" in a span (the card is a button) with the band tone', () => {
    const html = render();
    expect(html).toContain('84 · Hot');
    expect(html).toContain('text-success');
    expect(html.startsWith('<span')).toBe(true);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('lead-score-risk');
  });

  it('uses the warning and muted tones for warm and cold', () => {
    expect(render({ score: 50, band: 'warm' })).toMatch(
      /text-warning.*50 · Warm/
    );
    expect(render({ score: 12, band: 'cold' })).toMatch(
      /text-muted-foreground.*12 · Cold/
    );
  });

  it('shows the risk dot when at risk', () => {
    expect(render({ atRisk: true })).toContain('lead-score-risk');
  });

  it('has Korean words for every band and reason', () => {
    const html = render({}, ko as AbstractIntlMessages, 'ko');
    expect(html).toContain('84 · 뜨거움');
  });
});
