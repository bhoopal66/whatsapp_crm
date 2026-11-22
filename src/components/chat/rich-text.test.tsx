import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { RichText } from './rich-text';

const SARA = '0f8fad5b-d9cb-469f-a165-70867728950e';
const people = [{ userId: SARA, fullName: 'Sara Ahmed' }];
const html = (body: string, trailing?: React.ReactNode) =>
  renderToStaticMarkup(
    React.createElement(RichText, {
      body,
      people,
      unknownName: 'Unknown',
      trailing,
    })
  );

describe('RichText', () => {
  it('links https URLs with rel and target', () => {
    const out = html('see https://a.io/x.');
    expect(out).toContain(
      '<a href="https://a.io/x" target="_blank" rel="noopener noreferrer nofollow"'
    );
    expect(out).toContain('break-words');
    expect(out).toContain('</a>.');
  });

  it('renders no anchor for a non-http URL', () => {
    for (const s of ['javascript:alert(1)', 'www.x.com', 'data:text/html,x'])
      expect(html(s)).not.toContain('<a');
  });

  it('escapes <script> text', () => {
    const out = html('<script>alert(1)</script> *b*');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('<strong>b</strong>');
  });

  it('inline code and code blocks are monospace on bg-muted', () => {
    const out = html('`*x*`\n\n```\n<b>y</b>\n```');
    expect(out).toMatch(
      /<code class="[^"]*bg-muted[^"]*font-mono[^"]*">\*x\*<\/code>/
    );
    expect(out).toMatch(
      /<pre class="[^"]*bg-muted[^"]*overflow-x-auto[^"]*font-mono/
    );
    expect(out).toContain('&lt;b&gt;y&lt;/b&gt;');
  });

  it('quotes have a start-side border (left in LTR, right in RTL)', () => {
    expect(html('> hi')).toMatch(
      /<blockquote dir="auto" class="[^"]*border-s-4[^"]*">hi<\/blockquote>/
    );
  });

  it('lists render as ul / ol', () => {
    expect(html('- a\n- b')).toContain('<li>a</li><li>b</li></ul>');
    expect(html('2. a\n3. b')).toMatch(
      /<ol dir="auto" start="2"[^>]*><li>a<\/li><li>b<\/li><\/ol>/
    );
  });

  it('paragraphs are dir="auto" and keep line breaks', () => {
    expect(html('مرحبا\nhello')).toContain(
      '<p dir="auto" class="whitespace-pre-wrap">مرحبا<br/>hello</p>'
    );
  });

  it('mentions render as chips, inside bold too', () => {
    const out = html(`*<@${SARA}>* @here`);
    expect(out).toContain(
      '<strong><span class="rounded px-1 font-semibold bg-primary-soft text-primary">@Sara Ahmed</span></strong>'
    );
    expect(out).toContain('@here</span>');
  });

  it('puts the trailing node inside the last paragraph', () => {
    const out = html('a', React.createElement('span', null, 'edited'));
    expect(out).toContain('a<span>edited</span></p>');
    expect(html('- a', 'E')).toMatch(/<\/ul>E<\/div>$/);
  });
});
