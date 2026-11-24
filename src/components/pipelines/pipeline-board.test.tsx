import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';

import en from '../../../messages/en.json';
import type { BoardDeal } from '@/lib/pipelines/board-deal';
import type { PipelineStage } from '@/types';
import { PipelineBoard } from './pipeline-board';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ defaultCurrency: 'AED' }),
}));
vi.mock('@/hooks/use-chat-tags', () => ({
  useChatTags: () => ({ tags: [] }),
}));
vi.mock('@/components/context-menu/registry', () => ({
  useContextMenuItems: () => {},
}));
vi.mock('@/components/context-menu/app-context-menu', () => ({
  copyWithToast: vi.fn(),
}));

const stage = {
  id: 'stage-1',
  name: 'New Lead',
  color: '#3366cc',
  position: 0,
} as PipelineStage;
const deal = {
  id: 'deal-1',
  title: 'Example Trading LLC',
  stage_id: 'stage-1',
  status: 'open',
  value: 1000,
  currency: 'AED',
} as BoardDeal;

function render(readOnly = false, deals: BoardDeal[] = [deal]) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en as AbstractIntlMessages}>
      <PipelineBoard
        stages={[stage]}
        deals={deals}
        members={[]}
        readOnly={readOnly}
        onDealMoved={() => {}}
        onAddDeal={() => {}}
        onEditDeal={() => {}}
      />
    </NextIntlClientProvider>
  );
}

/** The opening tags the deal's title sits inside, outermost first. */
function ancestorsOfTitle(html: string): string[] {
  const open: string[] = [];
  const before = html.slice(0, html.indexOf(deal.title));
  for (const [tag] of before.matchAll(/<[^>]+>/g)) {
    if (tag.startsWith('</')) open.pop();
    else if (!tag.endsWith('/>')) open.push(tag);
  }
  return open;
}

const isInteractive = (tag: string) =>
  tag.startsWith('<button') || /role="button"|tabindex="0"/.test(tag);

describe('PipelineBoard column total', () => {
  it('never adds two currencies', () => {
    const html = render(false, [
      { ...deal, id: 'd1', value: 150000 },
      { ...deal, id: 'd2', value: 50000, currency: undefined },
      { ...deal, id: 'd3', value: 100000, currency: 'USD' },
    ]);
    expect(html).toContain('>AED 200,000 + USD 100,000<');
    // A deal without a currency is in the account's, on its card too.
    expect(html).toMatch(/AED\s50,000/);
  });

  it('is one amount in one currency', () => {
    expect(render()).toMatch(/>AED\s1,000<\/p>/);
  });
});

describe('PipelineBoard deal cards', () => {
  it('make the card one button, not a button inside a drag handle', () => {
    const controls = ancestorsOfTitle(render()).filter(isInteractive);
    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatch(/^<button/);
    // Still the drag handle.
    expect(controls[0]).toContain('aria-roledescription="draggable"');
  });

  it('are plain buttons on a read-only board', () => {
    const controls = ancestorsOfTitle(render(true)).filter(isInteractive);
    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatch(/^<button/);
    expect(controls[0]).not.toContain('draggable');
    expect(controls[0]).not.toContain('aria-disabled');
  });
});
