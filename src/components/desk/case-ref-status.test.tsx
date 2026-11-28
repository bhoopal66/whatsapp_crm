import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import ar from '../../../messages/ar.json';
import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';

import { CaseRefStatus } from './case-ref-status';

function render(stage: string, locale: string, messages: object) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <CaseRefStatus
        banks={[]}
        lookup={{
          status: 'found',
          found: {
            caseId: '00000000-0000-0000-0000-000000000001',
            caseNumber: 'TC-1001',
            bankCode: null,
            companyName: 'Acme Trading',
            contactId: null,
            product: null,
            stage,
          },
        }}
      />
    </NextIntlClientProvider>
  );
}

describe('the desk case lookup', () => {
  it('shows a built-in stage in the screen language', () => {
    expect(render('Submitted', 'ar', ar)).toContain(ar.StageNames.submitted);
    expect(render('Submitted', 'ar', ar)).not.toContain('Submitted');
    expect(render('Under review', 'ko', ko)).toContain(
      ko.StageNames.underReview
    );
    expect(render('Submitted', 'en', en)).toContain('Submitted');
  });

  it("shows a bank's own stage exactly as stored", () => {
    expect(render('Valuation booked', 'ar', ar)).toContain('Valuation booked');
  });
});
