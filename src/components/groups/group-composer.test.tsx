import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';

// The quick-reply picker loads the account's snippets through Supabase;
// a server render needs none of it.
vi.mock('@/components/inbox/quick-reply-picker', () => ({
  QuickReplyPicker: () => null,
}));

import { GroupComposer } from './group-composer';

// Server-side render only (no DOM here): both group chats mount this
// composer, so a render crash would take the whole chat down.
function render(props: Partial<React.ComponentProps<typeof GroupComposer>>) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <GroupComposer
        chatKey="group:g"
        chatName="Acme"
        userId="u"
        onSendText={async () => true}
        onSendMedia={async () => true}
        placeholder="Type a message"
        {...props}
      />
    </NextIntlClientProvider>
  );
}

describe('GroupComposer', () => {
  it('renders the text box, the hidden file pickers and the notice', () => {
    const html = render({ notice: 'Sent as Ali (Agent)' });
    expect(html).toContain('Type a message');
    expect(html).toContain('Sent as Ali (Agent)');
    expect(html.match(/type="file"/g)?.length).toBe(3);
    expect(html).toContain('image/png,image/jpeg,image/webp');
  });

  it('has a mic where Send will be while the box is empty', () => {
    const html = render({});
    expect(html).toContain('aria-label="Record a voice note"');
    expect(html).not.toContain('aria-label="Send"');
  });

  it('shows why it is disabled instead of the notice', () => {
    const html = render({
      disabled: true,
      disabledReason: 'You cannot send here',
      notice: 'Sent as Ali (Agent)',
    });
    expect(html).toContain('You cannot send here');
    expect(html).not.toContain('Sent as Ali (Agent)');
    expect(html).toMatch(/<textarea[^>]*disabled/);
    expect(html).toMatch(
      /<button(?=[^>]*aria-label="Record a voice note")[^>]*\sdisabled/
    );
  });
});
