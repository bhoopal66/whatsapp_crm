import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';
import type { BankSummary } from '@/lib/banks/ui';

import { BankSummaryStrip } from './bank-summary-strip';

// Server-side render only (no DOM here): pins the strip's wording, its
// ICU plurals in both catalogues, and that a missing role leaves the
// role item out rather than showing a raw key.

const summary = (over: Partial<BankSummary> = {}): BankSummary => ({
  openCases: 14,
  members: { agents: 3, coordinators: 2, teamLeads: 1, total: 6 },
  openActions: 2,
  myRole: 'coordinator',
  ...over,
});

function render(s: BankSummary, locale: 'en' | 'ko' = 'en') {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === 'en' ? en : ko}
    >
      <BankSummaryStrip summary={s} />
    </NextIntlClientProvider>
  ).replace(/<[^>]+>/g, ' ');
}

describe('BankSummaryStrip', () => {
  it('shows the walkthrough figures with plurals', () => {
    const text = render(summary());
    expect(text).toContain('Open cases');
    expect(text).toContain('14');
    expect(text).toContain('6 (3 agents, 2 coordinators, 1 team lead)');
    expect(text).toContain('2 open');
    expect(text).toContain('Your role here');
    expect(text).toContain('Coordinator');
  });

  it('uses the singular for one of each', () => {
    const text = render(
      summary({
        members: { agents: 1, coordinators: 1, teamLeads: 0, total: 2 },
      })
    );
    expect(text).toContain('2 (1 agent, 1 coordinator, 0 team leads)');
  });

  it('names each role', () => {
    expect(render(summary({ myRole: 'admin' }))).toContain('Admin');
    expect(render(summary({ myRole: 'team_lead' }))).toContain('Team lead');
    expect(render(summary({ myRole: 'agent' }))).toContain('Agent');
  });

  it('leaves the role out when it is unknown', () => {
    expect(render(summary({ myRole: null }))).not.toContain('Your role here');
  });

  it('renders the Korean catalogue', () => {
    const text = render(summary(), 'ko');
    expect(text).toContain('6명 (담당자 3명, 코디네이터 2명, 팀 리더 1명)');
    expect(text).toContain('코디네이터');
  });
});
