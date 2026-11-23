import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RowWriter } from '@/lib/supabase/changed-rows';
import {
  dealFormDirty,
  dealPatch,
  saveDealEdit,
  shouldFillDealForm,
  type DealInputs,
} from './deal-edit';

const filled: DealInputs = {
  title: 'Deal ',
  value: '100',
  currency: 'AED',
  contactId: 'c1',
  stageId: 's1',
  assignedTo: '',
  expectedCloseDate: '',
  notes: '',
};

/** One deal row; `visible` false is RLS filtering it. */
function fakeDeals(row: Record<string, unknown>, visible = true) {
  const writes: Record<string, unknown>[] = [];
  const sb = {
    from: () => ({
      update: (patch: Record<string, unknown>) => ({
        eq: () => ({
          select: async () => {
            writes.push(patch);
            if (visible) Object.assign(row, patch);
            return { data: visible ? [{ id: row.id }] : [], error: null };
          },
        }),
      }),
    }),
  };
  return { sb: sb as unknown as RowWriter, writes };
}

describe('dealPatch', () => {
  it('sends only what was changed, a cleared field as null', () => {
    const edit = (typed: Partial<DealInputs>) =>
      dealPatch(filled, { ...filled, ...typed }, 'p1');
    expect(edit({})).toEqual({});
    expect(edit({ value: '250' })).toEqual({ value: 250 });
    expect(edit({ value: '100.0' })).toEqual({});
    expect(
      dealPatch({ ...filled, notes: 'x' }, { ...filled, notes: ' ' }, 'p1')
    ).toEqual({ notes: null });
  });

  it('sends the pipeline with a changed stage', () => {
    expect(dealPatch(filled, { ...filled, stageId: 's2' }, 'p1')).toEqual({
      stage_id: 's2',
      pipeline_id: 'p1',
    });
  });
});

describe('saveDealEdit', () => {
  it("keeps a colleague's move to another stage", async () => {
    const row: Record<string, unknown> = { id: 'd1', stage_id: 's3' };
    const { sb, writes } = fakeDeals(row);
    expect(
      await saveDealEdit(sb, 'd1', filled, { ...filled, notes: 'call' }, 'p1')
    ).toEqual({ kind: 'changed', ids: ['d1'] });
    expect(writes).toEqual([{ notes: 'call' }]);
    expect(row.stage_id).toBe('s3');
  });

  it('writes nothing when nothing was changed', async () => {
    const { sb, writes } = fakeDeals({ id: 'd1' });
    expect(await saveDealEdit(sb, 'd1', filled, filled, 'p1')).toEqual({
      kind: 'unchanged',
    });
    expect(writes).toEqual([]);
  });

  it('answers none when the deal can no longer be changed', async () => {
    const { sb } = fakeDeals({ id: 'd1' }, false);
    expect(
      await saveDealEdit(sb, 'd1', filled, { ...filled, title: 'X' }, 'p1')
    ).toEqual({ kind: 'none' });
  });
});

describe('refilling the open form', () => {
  it('keeps what was typed for the same deal, takes another deal', () => {
    expect(dealFormDirty(filled, { ...filled })).toBe(false);
    expect(dealFormDirty(filled, { ...filled, notes: 'n' })).toBe(true);
    expect(shouldFillDealForm('d1', 'd1', true)).toBe(false);
    expect(shouldFillDealForm('d1', 'd1', false)).toBe(true);
    expect(shouldFillDealForm('d1', 'd2', true)).toBe(true);
    expect(shouldFillDealForm(null, 'new', true)).toBe(true);
  });

  it('is what the form does', () => {
    const form = readFileSync(
      join(process.cwd(), 'src/components/pipelines/deal-form.tsx'),
      'utf8'
    );
    expect(form).toContain('shouldFillDealForm(filledFor.current');
    expect(form).toContain('saveDealEdit(');
  });
});
