import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import { HR_LIST_DEFAULTS, type HrTab } from '@/lib/hr/list-filters';
import type { HrCounts } from '@/lib/hr/types';

import { HrListHeaderView, HrListTitle } from './hr-list-header';

// The package's list header (023d-1) on the three fixed HR routes.

const COUNTS: HrCounts = {
  recruiter: { all: 6, unread: 3, mine: 0, urgent: 1 },
  dept: { all: 11, unread: 2, mine: 4, urgent: 2 },
  unsorted: 5,
};

function render(tab: HrTab, over = {}) {
  const filters = { ...HR_LIST_DEFAULTS, tab, ...over };
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      <HrListTitle tab={tab} />
      <HrListHeaderView
        filters={filters}
        onChange={() => {}}
        counts={COUNTS}
        fixedTab
      />
    </NextIntlClientProvider>
  );
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

describe('HrListHeaderView', () => {
  it('recruiter: title, quick chips with numbers, Stage and Reply state', () => {
    const out = text(render('recruiter'));
    expect(out).toContain('Recruiter HR');
    expect(out).toContain('All 6 Unread 3 Mine 0 Urgent 1');
    expect(out).toContain('Stage Any CV review');
    expect(out).toContain('Reply state Any New Reply due Waiting on them');
    expect(out).not.toContain('Topic');
    expect(out).toContain('Closed');
  });

  it('dept: sub-line, topic groups, Topic dropdown', () => {
    const out = text(render('dept'));
    expect(out).toContain('HR department Onboarded staff');
    expect(out).toContain('All 11 Unread 2 Mine 4 Urgent 2');
    expect(out).toContain('All Letters Training Leave Messages Exits');
    expect(out).toContain('Topic Any');
    expect(out).toContain('Reply state');
    expect(out).not.toContain('Stage');
  });

  it('not sorted: All and Mine only, no dropdowns', () => {
    const out = text(render('unsorted'));
    expect(out).toContain('Not sorted');
    expect(out).toContain('All 5 Mine');
    expect(out).not.toContain('Unread');
    expect(out).not.toContain('Urgent');
    expect(out).not.toContain('Reply state');
  });

  it('a removable chip per filter that is on', () => {
    const html = render('recruiter', { stage: 'ai_interview', mine: true });
    expect(html).toContain('aria-label="Remove filter: Mine"');
    expect(html).toContain('aria-label="Remove filter: Stage: AI interview"');
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Mine/);
  });
});
