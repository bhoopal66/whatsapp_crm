import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import type { GapTopicView } from '@/lib/kb/gap-topics-view';
import { GapTopicCard } from './ai-knowledge-gaps';

// The node environment cannot click, so this pins what one topic card
// shows for each coverage state; the ordering and badge rules live in
// lib/kb/gap-topics-view and are tested there.

const NOW = Date.parse('2026-10-29T12:00:00Z');

function topic(extra: Partial<GapTopicView> = {}): GapTopicView {
  return {
    id: 't1',
    label: 'Can I open a business account online?',
    intent: 'account_opening',
    question_count: 4,
    first_seen_at: '2026-10-20T10:00:00Z',
    last_seen_at: '2026-10-29T10:00:00Z',
    coverage: 'none',
    covered_by_entry_id: null,
    covered_by_title: null,
    status: 'open',
    dismissed_at: null,
    examples: ['How do I open an account?'],
    ...extra,
  };
}

function render(
  t: GapTopicView,
  opts: { onWrite?: boolean; busy?: 'write' | 'status' | null } = {}
) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={en}
      timeZone="UTC"
      now={new Date(NOW)}
    >
      <GapTopicCard
        topic={t}
        now={NOW}
        busy={opts.busy ?? null}
        disabled={false}
        onStatus={vi.fn()}
        onWrite={opts.onWrite === false ? undefined : vi.fn()}
      />
    </NextIntlClientProvider>
  );
}

describe('GapTopicCard', () => {
  it('shows the question, size, recency, intent and "No answer yet"', () => {
    const html = render(topic());
    expect(html).toContain('Can I open a business account online?');
    expect(html).toContain('4 questions');
    expect(html).toContain('last seen 2 hours ago');
    expect(html).toContain('Business bank account');
    expect(html).toContain('No answer yet');
    expect(html).toContain('bg-warning-soft');
    expect(html).toContain('Also asked 1 other way');
    expect(html).toContain('Write an approved answer');
    expect(html).toContain('Dismiss');
  });

  it('names the covering answer, with the floor hint only when full', () => {
    const partial = render(
      topic({ coverage: 'partial', covered_by_title: 'Account opening' })
    );
    expect(partial).toContain('Partly answered by Account opening');
    expect(partial).toContain('bg-info-soft');
    expect(partial).not.toContain('scores below the floor');

    const full = render(
      topic({ coverage: 'full', covered_by_title: 'Account opening' })
    );
    expect(full).toContain('Answered by Account opening');
    expect(full).toContain('bg-success-soft');
    expect(full).toContain('scores below the floor');
  });

  it('shows no badge and no intent chip when Jev did not judge the topic', () => {
    const html = render(
      topic({ coverage: 'unknown', intent: null, question_count: 1 })
    );
    expect(html).toContain('1 question<');
    expect(html).not.toContain('No answer yet');
    expect(html).not.toContain('answered');
    expect(html).not.toContain('Business bank account');
  });

  it('offers Reopen and no write action on a dismissed topic', () => {
    const html = render(
      topic({ status: 'dismissed', dismissed_at: '2026-10-28T00:00:00Z' })
    );
    expect(html).toContain('Reopen');
    expect(html).not.toContain('Write an approved answer');
  });

  it('has no write action without a host to hand the draft to', () => {
    expect(render(topic(), { onWrite: false })).not.toContain(
      'Write an approved answer'
    );
  });
});
