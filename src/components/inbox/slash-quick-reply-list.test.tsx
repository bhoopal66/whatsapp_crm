import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import type { QuickReply } from '@/types';

import { SlashQuickReplyList, slashOptionId } from './slash-quick-reply-list';

// The "/" list above the composer: options, highlight, empty states.

const qr = (id: string, title: string, body: string): QuickReply => ({
  id,
  account_id: 'a',
  user_id: 'u',
  title,
  kind: 'text',
  content_text: body,
  created_at: '',
  updated_at: '',
});

function render(props: Partial<Parameters<typeof SlashQuickReplyList>[0]>) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      <SlashQuickReplyList
        id="slash"
        query=""
        items={[]}
        loading={false}
        highlight={0}
        onPick={() => {}}
        onHighlight={() => {}}
        {...props}
      />
    </NextIntlClientProvider>
  );
}

describe('SlashQuickReplyList', () => {
  it('lists options with the highlighted one selected', () => {
    const html = render({
      items: [qr('1', 'Welcome message', 'Hello!'), qr('2', 'Thanks', 'Ty')],
      highlight: 1,
    });
    expect(html).toContain('role="listbox"');
    expect(html).toContain(`id="${slashOptionId('slash', 1)}"`);
    expect(html).toMatch(/id="slash-option-1"[^>]*aria-selected="true"/);
    expect(html).toMatch(/id="slash-option-0"[^>]*aria-selected="false"/);
    expect(html).toContain('/welcome-message');
    expect(html).toContain('Hello!');
  });

  it('names the query when nothing matches', () => {
    const html = render({ query: 'zzz' });
    expect(html).toContain('No quick replies match &quot;zzz&quot;');
    expect(html).not.toContain('role="listbox"');
  });

  it('says there are none with an empty query', () => {
    expect(render({})).toContain('No quick replies yet.');
  });

  it('shows loading', () => {
    expect(render({ loading: true })).toContain('Loading quick replies');
  });
});
