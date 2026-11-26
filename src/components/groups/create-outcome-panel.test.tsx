import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';
import { CreateOutcomePanel } from './create-outcome-panel';

const noop = () => {};
const html = (kind: 'unconfirmed' | 'repeat') =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={{ Groups: en.Groups } as never}
    >
      <CreateOutcomePanel
        kind={kind}
        onBack={noop}
        onCheck={noop}
        onCreateAnother={noop}
      />
    </NextIntlClientProvider>
  );

describe('CreateOutcomePanel', () => {
  it('sends an unconfirmed create to Groups, never to another create', () => {
    const out = html('unconfirmed');
    expect(out).toContain('The group may have been created');
    expect(out).toContain('Check Groups');
    expect(out).not.toContain('Create another');
  });

  it('offers another group only after the server saw a repeat', () => {
    expect(html('repeat')).toContain('Create another');
  });
});
