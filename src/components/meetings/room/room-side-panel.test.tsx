import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { MessageSquare, NotebookPen, Users } from 'lucide-react';

import en from '../../../../messages/en.json';

import { PanelCard } from './room-side-panel';

// The node environment has no layout, so a real measurement of the tabs at
// the narrowest panel lives in the browser drive. This pins the CSS that
// makes them fit: without it the strip overflows at 280px.
function strip() {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      <PanelCard
        tabs={[
          { id: 'people', label: 'People', Icon: Users, count: 2 },
          { id: 'chat', label: 'Chat', Icon: MessageSquare, unread: 1 },
          { id: 'notes', label: 'Notes', Icon: NotebookPen },
        ]}
        active="people"
        onSelect={() => {}}
        onClose={() => {}}
      >
        <p>body</p>
      </PanelCard>
    </NextIntlClientProvider>
  );
}

describe('PanelCard tab strip', () => {
  it('is a size container, so a narrow panel can restyle its tabs', () => {
    expect(strip()).toMatch(
      /class="@container [^"]*"[^>]*><div[^>]*role="tablist"/
    );
  });

  it('drops every tab icon in a narrow panel', () => {
    const icons = strip().match(
      /<svg[^>]*lucide-(users|message-square|notebook-pen)[^>]*>/g
    );
    expect(icons).toHaveLength(3);
    for (const icon of icons ?? []) {
      expect(icon).toContain('@max-[21rem]:hidden');
    }
  });

  it('sizes each tab to its words in a narrow panel', () => {
    const tabs = strip().match(/<button[^>]*role="tab"[^>]*>/g);
    expect(tabs).toHaveLength(3);
    for (const tab of tabs ?? []) {
      expect(tab).toContain('@max-[21rem]:flex-auto');
      expect(tab).toContain('@max-[21rem]:min-w-0');
    }
  });
});
