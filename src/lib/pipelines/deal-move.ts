// A deal dragged to another stage: the card moves at once, the write
// follows, and a write that changed nothing puts the card back.

import type { RowWrite } from '@/lib/supabase/changed-rows';

interface Placed {
  id: string;
  stage_id: string;
}

/** The card on `to`, shown before the write answers. */
export function placeDeal<T extends Placed>(
  deals: readonly T[],
  id: string,
  to: string
): T[] {
  return deals.map((d) => (d.id === id ? { ...d, stage_id: to } : d));
}

/** The card back on `from`, unless it was moved on since. */
export function putDealBack<T extends Placed>(
  deals: readonly T[],
  id: string,
  from: string,
  to: string
): T[] {
  return deals.map((d) =>
    d.id === id && d.stage_id === to ? { ...d, stage_id: from } : d
  );
}

/**
 * Moves the card, persists, and on anything but a changed row puts the
 * card back and re-reads the board (which drops a deal that is gone).
 */
export async function moveDeal<T extends Placed>(move: {
  deals: readonly T[];
  dealId: string;
  to: string;
  setDeals: (fn: (prev: T[]) => T[]) => void;
  write: () => Promise<RowWrite>;
  refresh: () => Promise<void> | void;
}): Promise<RowWrite['kind']> {
  const { dealId, to } = move;
  const from = move.deals.find((d) => d.id === dealId)?.stage_id;
  move.setDeals((prev) => placeDeal(prev, dealId, to));
  const res = await move.write();
  if (res.kind === 'changed') return res.kind;
  if (from !== undefined)
    move.setDeals((prev) => putDealBack(prev, dealId, from, to));
  void move.refresh();
  return res.kind;
}
