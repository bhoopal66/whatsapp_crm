import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import {
  BACK_LABEL_KEYS,
  recordNavigation,
  resetBackTarget,
} from '@/lib/navigation/back-target';

// Server rendering cannot click, so this pins what each plan renders:
// a real link to the fallback in a fresh document, a real button once
// the tab has an in-app page behind the current one.

const mocks = vi.hoisted(() => ({ pathname: '/contacts/1' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
  usePathname: () => mocks.pathname,
}));

import { BackLink } from './back-link';

function render(el: React.ReactElement) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      {el}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  resetBackTarget();
  mocks.pathname = '/contacts/1';
});

describe('BackLink', () => {
  it('links to the fallback, named after it, in a fresh document', () => {
    const html = render(<BackLink fallbackHref="/team-contacts" />);
    expect(html).toContain('href="/team-contacts"');
    expect(html).toContain('Back to Team contacts');
    expect(html).not.toContain('<button');
  });

  it('uses fallbackLabel in link mode', () => {
    const html = render(
      <BackLink fallbackHref="/flows/f1" fallbackLabel="My flow" />
    );
    expect(html).toContain('My flow');
  });

  it('is a button back to where the tab came from', () => {
    recordNavigation('/calls');
    const html = render(
      <BackLink fallbackHref="/contacts" fallbackLabel="X" />
    );
    expect(html).toContain('<button type="button"');
    expect(html).toContain('Back to Calls');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('X');
  });

  it('keeps the label as the accessible name when icon-only', () => {
    const html = render(<BackLink fallbackHref="/cases" iconOnly />);
    expect(html).toContain('aria-label="Back to Cases"');
    expect(html).not.toContain('>Back to Cases<');
  });

  it('every label key has an English message', () => {
    const msgs: Record<string, string> = en.BackNav;
    for (const key of BACK_LABEL_KEYS) expect(msgs[key], key).toBeTruthy();
  });
});
