/**
 * The shared loading / error states and the Flow-or-Automation help,
 * rendered server-side (no DOM in the test env).
 */
import { NextIntlClientProvider } from 'next-intl';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';
import { ErrorState } from './error-state';
import { FlowVsAutomationHelp } from './flow-vs-automation-help';
import { LoadingState } from './loading-state';

function render(node: ReactElement) {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, { locale: 'en', messages: en }, node)
  );
}

describe('LoadingState', () => {
  it('is a busy status region with the default label', () => {
    const html = render(createElement(LoadingState));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading…');
  });

  it('takes a custom label', () => {
    expect(
      render(createElement(LoadingState, { label: 'Loading flows' }))
    ).toContain('Loading flows');
  });
});

describe('ErrorState', () => {
  it('shows an alert with a plain message and no button by default', () => {
    const html = render(createElement(ErrorState));
    expect(html).toContain('role="alert"');
    expect(html).toContain('Something went wrong');
    expect(html).toContain('We could not load this');
    expect(html).not.toContain('<button');
  });

  it('shows a Retry button when a handler is given', () => {
    const html = render(
      createElement(ErrorState, { message: 'Nope', onRetry: () => {} })
    );
    expect(html).toContain('Nope');
    expect(html).toContain('<button');
    expect(html).toContain('Try again');
  });
});

describe('FlowVsAutomationHelp', () => {
  it('explains both in plain words', () => {
    const html = render(createElement(FlowVsAutomationHelp));
    expect(html).toContain('Flow or Automation?');
    expect(html).toContain('back-and-forth conversation');
    expect(html).toContain('rule that runs steps');
  });
});
