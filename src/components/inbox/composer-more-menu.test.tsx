import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { Zap } from 'lucide-react';

import en from '../../../messages/en.json';

import { ComposerMoreMenu, type ComposerMenuItem } from './composer-more-menu';

// The composer's single "More" menu: a labelled "+" trigger. The items
// only render once open (no DOM here), so this pins the trigger.

function render(items: ComposerMenuItem[], disabled = false) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      <ComposerMoreMenu items={items} disabled={disabled} />
    </NextIntlClientProvider>
  );
}

const ITEM: ComposerMenuItem = {
  id: 'quick-replies',
  icon: Zap,
  label: 'Quick replies',
  onSelect: () => {},
};

describe('ComposerMoreMenu', () => {
  it('shows a visible "More" word and an accessible name', () => {
    const html = render([ITEM]);
    expect(html).toContain('aria-label="More actions"');
    expect(html).toContain('>More</span>');
    // The word is screen-reader-only on a phone, visible from sm up.
    expect(html).toContain('max-sm:sr-only');
  });

  it('is disabled when every item is hidden', () => {
    const html = render([{ ...ITEM, hidden: true }]);
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it('is enabled with a visible item', () => {
    const html = render([ITEM]);
    expect(html).not.toMatch(/<button[^>]*disabled=""/);
  });
});
