import { readFileSync } from 'node:fs';
import path from 'node:path';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { BankTag } from './bank-tag';

/**
 * Regression: scrolling /groups or /submission-groups moved the whole
 * page up, top bar included. Each list row holds `sr-only` text, which
 * is `position: absolute`. With no positioned ancestor its containing
 * block is the page, so a row far down the list stretched the document
 * past the screen (overflow-hidden panes do not clip it) and the
 * browser scrolled the window. A `relative` ancestor keeps it inside
 * the pane.
 */
describe('sr-only text in the group lists has a positioned ancestor', () => {
  it('the bank tag anchors its own label', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider
        locale="en"
        messages={{ SubmissionGroups: { bank: 'Bank: {bank}' } }}
      >
        <BankTag code="ADCB" name="ADCB" />
      </NextIntlClientProvider>
    );
    const root = html.match(/^<span class="([^"]*)"/)?.[1] ?? '';
    expect(root.split(/\s+/)).toContain('relative');
    expect(html).toContain('sr-only');
  });

  it.each([
    'src/components/groups/groups-list.tsx',
    'src/components/submission-groups/submission-groups-list.tsx',
  ])('%s: the scrolling list is positioned', (file) => {
    const src = readFileSync(path.join(process.cwd(), file), 'utf8');
    const scrollers = [
      ...src.matchAll(/className="([^"]*overflow-y-auto[^"]*)"/g),
    ];
    expect(scrollers.length).toBeGreaterThan(0);
    for (const [, cls] of scrollers) {
      expect(cls.split(/\s+/)).toContain('relative');
    }
  });
});
