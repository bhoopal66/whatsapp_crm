import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import { FilePreview, PreviewBeside } from './file-preview';

// Node tests cannot mount a component: the first render is checked
// server-side with the real catalogue. Fetching, kinds and failures are
// the pure helpers in lib/desk/preview.test.ts and the route tests.

const ITEM = '11111111-1111-4111-8111-111111111111';
const html = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      {node}
    </NextIntlClientProvider>
  );

describe('FilePreview', () => {
  it('waits for a press on the tray: a button, no link yet', () => {
    const out = html(
      <FilePreview
        target={{ type: 'tray', id: ITEM }}
        mime="application/pdf"
        name="licence.pdf"
      />
    );
    expect(out).toContain('aria-label="File: licence.pdf"');
    expect(out).toContain('Show file');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('href=');
  });

  it('starts loading at once beside the sort panel, with a word', () => {
    const out = html(
      <FilePreview
        target={{ type: 'intake', id: ITEM }}
        mime="image/png"
        name={null}
        autoLoad
      />
    );
    expect(out).toContain('role="status"');
    expect(out).toContain('Loading the file…');
    expect(out).toContain('Unnamed file');
    expect(out).not.toContain('Show file');
  });
});

describe('PreviewBeside', () => {
  it('stacks on a phone and goes side by side from lg', () => {
    const out = html(
      <PreviewBeside preview={<p>preview</p>}>
        <p>panel</p>
      </PreviewBeside>
    );
    expect(out).toContain('grid gap-3 lg:grid-cols-2');
    expect(out.indexOf('preview')).toBeLessThan(out.indexOf('panel'));
  });

  it('is only the panel when there is no file', () => {
    expect(
      html(
        <PreviewBeside preview={false}>
          <p>panel</p>
        </PreviewBeside>
      )
    ).toBe('<p>panel</p>');
  });
});
