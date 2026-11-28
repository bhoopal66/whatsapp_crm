import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import type { HrListRow } from '@/lib/hr/list-filters';
import { HR_TOPIC_DOT } from '@/lib/hr/topic-ui';

import { HrRowTags, HrStaffRing } from './hr-row';

const dept = (topic: HrListRow['topic']): HrListRow => ({
  inbox: 'dept',
  stage_key: null,
  topic,
  urgent: false,
  upset: false,
  reply_state: 'new',
  outcome: null,
  closed_at: null,
});

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      {node}
    </NextIntlClientProvider>
  );

describe('HrRowTags topic dot', () => {
  it('colours the dot by topic, Termination included', () => {
    const term = render(<HrRowTags hr={dept('termination')} />);
    const pay = render(<HrRowTags hr={dept('payroll')} />);
    expect(term).toContain(HR_TOPIC_DOT.termination);
    expect(pay).toContain(HR_TOPIC_DOT.payroll);
    expect(pay).not.toContain(HR_TOPIC_DOT.termination);
  });
});

describe('HrStaffRing', () => {
  it('draws a teal ring inside the avatar for a department row', () => {
    const html = render(
      <HrStaffRing hr={dept(null)}>
        <b>EE</b>
      </HrStaffRing>
    );
    expect(html).toContain('aria-label="Staff"');
    expect(html).toContain('border-wa-teal');
    expect(html).toContain('absolute inset-0');
  });

  it('passes any other avatar through', () => {
    const html = render(
      <HrStaffRing hr={{ ...dept(null), inbox: 'recruiter' }}>
        <b>EE</b>
      </HrStaffRing>
    );
    expect(html).toBe('<b>EE</b>');
  });
});
