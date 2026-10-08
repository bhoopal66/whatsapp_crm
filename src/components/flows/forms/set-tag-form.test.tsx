import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../../messages/en.json';
import { buildChatTagTree } from '@/lib/chat-tags/tree';
import type { ChatTag } from '@/types';

// The Set chat tag node's form, rendered on the server (no DOM here):
// what the closed selects read is the label the admin acts on.

const mocks = vi.hoisted(() => ({ tags: [] as unknown[] }));

vi.mock('@/hooks/use-chat-tags', () => ({
  useChatTags: () => {
    const tags = mocks.tags as ChatTag[];
    return {
      tags,
      tree: buildChatTagTree(tags),
      loading: false,
      reload: vi.fn(),
    };
  },
}));
vi.mock('@/lib/storage/upload-media', () => ({
  uploadAccountMedia: vi.fn(),
  MEDIA_MAX_BYTES: 1,
}));

import { NodeConfigForm } from './node-config-form';

function tag(
  id: string,
  name: string,
  parent_id: string | null = null,
  sub_tag_title: string | null = null
): ChatTag {
  return {
    id,
    account_id: 'acc-1',
    parent_id,
    name,
    color: '#10b981',
    sub_tag_title,
    position: 0,
    created_at: '2026-10-08T00:00:00Z',
    updated_at: '2026-10-08T00:00:00Z',
  };
}

const INTERESTED = '11111111-1111-4111-8111-000000000002';
const ADCB = '11111111-1111-4111-8111-000000000011';

function render(config: Record<string, unknown>): string {
  mocks.tags = [
    tag(INTERESTED, 'Interested customer', null, 'Bank'),
    tag(ADCB, 'ADCB', INTERESTED),
  ];
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      <NodeConfigForm
        node={{ node_key: 'tag_it', node_type: 'set_tag', config }}
        allNodes={[]}
        showAdvanced={false}
        onUpdateConfig={() => {}}
      />
    </NextIntlClientProvider>
  );
}

/** What every closed select shows: its `select-value` span's text. */
function shownValues(html: string): string[] {
  return [...html.matchAll(/data-slot="select-value"[^>]*>(.*?)<\/span>/g)].map(
    (m) => m[1].replace(/<[^>]+>/g, '')
  );
}

describe('Set chat tag node form', () => {
  it('labels the default sub-tag choice "Keep current", never "Deleted tag"', () => {
    const shown = shownValues(render({ chat_tag_id: INTERESTED }));
    expect(shown).toContain('Keep current Bank');
    expect(shown.join('|')).not.toMatch(/Deleted tag|__keep__/);
  });

  it('labels an explicit null as "No Bank"', () => {
    const shown = shownValues(
      render({ chat_tag_id: INTERESTED, chat_sub_tag_id: null })
    );
    // (The "Then advance to" select's own empty state is a separate,
    // older matter; this checks the sub-tag select.)
    expect(shown).toContain('No Bank');
  });

  it('still names a sub-tag that was deleted', () => {
    const shown = shownValues(
      render({
        chat_tag_id: INTERESTED,
        chat_sub_tag_id: '11111111-1111-4111-8111-0000000000ff',
      })
    );
    expect(shown).toContain('Deleted tag');
  });
});
