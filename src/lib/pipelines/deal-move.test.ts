import { describe, expect, it, vi } from 'vitest';

import type { RowWrite } from '@/lib/supabase/changed-rows';

import { moveDeal } from './deal-move';

const error = { message: 'x' } as never;

/** A board holding two deals, and one move of `d1` from A to B. */
function board(write: () => Promise<RowWrite>) {
  const state = {
    deals: [
      { id: 'd1', stage_id: 'A' },
      { id: 'd2', stage_id: 'A' },
    ],
    refresh: vi.fn(),
  };
  const stageOf = (id: string) =>
    state.deals.find((d) => d.id === id)?.stage_id;
  const run = () =>
    moveDeal({
      deals: state.deals,
      dealId: 'd1',
      to: 'B',
      setDeals: (fn) => {
        state.deals = fn(state.deals);
      },
      write,
      refresh: state.refresh,
    });
  return { state, stageOf, run };
}

describe('moveDeal', () => {
  it('shows the move before the write answers, and keeps it', async () => {
    const seen: (string | undefined)[] = [];
    const b = board(async () => {
      seen.push(b.stageOf('d1'));
      return { kind: 'changed', ids: ['d1'] };
    });
    expect(await b.run()).toBe('changed');
    expect(seen).toEqual(['B']);
    expect(b.stageOf('d1')).toBe('B');
    expect(b.state.refresh).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing changed', { kind: 'none' } as const],
    ['the write failed', { kind: 'failed', error } as const],
  ])('puts the card back and re-reads when %s', async (_, res) => {
    const b = board(async () => res);
    expect(await b.run()).toBe(res.kind);
    expect(b.stageOf('d1')).toBe('A');
    expect(b.stageOf('d2')).toBe('A');
    expect(b.state.refresh).toHaveBeenCalledTimes(1);
  });

  it('leaves a card that was moved on since', async () => {
    const b = board(async () => {
      b.state.deals = b.state.deals.map((d) =>
        d.id === 'd1' ? { ...d, stage_id: 'C' } : d
      );
      return { kind: 'none' };
    });
    await b.run();
    expect(b.stageOf('d1')).toBe('C');
  });
});
