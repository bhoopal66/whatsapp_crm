import { describe, expect, it } from 'vitest';

import type { RowWriter } from '@/lib/supabase/changed-rows';

import {
  canEditCustomValues,
  customFieldNames,
  customValueChanges,
  saveCustomValues,
  settleCustomValues,
  type CustomValues,
} from './custom-values';

const fields = [
  { id: 'f1', field_name: 'Salary' },
  { id: 'f2', field_name: 'Employer' },
];
const ok = (data: unknown) => ({ data, error: null });
const bad = { data: null, error: { message: 'timeout' } };

describe('settleCustomValues', () => {
  it('is ready once both reads succeeded', () => {
    expect(
      settleCustomValues(
        ok(fields),
        ok([
          { custom_field_id: 'f1', value: '9000' },
          { custom_field_id: 'f2', value: null },
        ])
      )
    ).toEqual({
      status: 'ready',
      fields,
      values: { f1: '9000', f2: '' },
    });
  });

  it('is failed, not empty, when either read failed', () => {
    expect(settleCustomValues(ok(fields), bad)).toEqual({ status: 'failed' });
    expect(settleCustomValues(bad, ok([]))).toEqual({ status: 'failed' });
    expect(settleCustomValues(ok(fields), ok(null))).toEqual({
      status: 'failed',
    });
  });

  it('keeps editing closed until then', () => {
    const ready = settleCustomValues(ok(fields), ok([]));
    expect(canEditCustomValues(ready, true)).toBe(true);
    expect(canEditCustomValues(ready, false)).toBe(false);
    expect(canEditCustomValues({ status: 'loading' }, true)).toBe(false);
    expect(canEditCustomValues(settleCustomValues(ok(fields), bad), true)).toBe(
      false
    );
    expect(canEditCustomValues(settleCustomValues(ok([]), ok([])), true)).toBe(
      false
    );
  });
});

describe('customValueChanges', () => {
  const loaded = { f1: '9000', f2: 'Acme' };

  it('is empty for an untouched draft, or one that only gained spaces', () => {
    expect(customValueChanges(loaded, { ...loaded })).toEqual({
      set: [],
      clear: [],
    });
    expect(customValueChanges(loaded, { f1: '9000 ', f3: ' ' })).toEqual({
      set: [],
      clear: [],
    });
  });

  it('sets what was changed or added, clears what was emptied', () => {
    expect(
      customValueChanges(loaded, { f1: ' 9500 ', f2: '  ', f3: 'UAE' })
    ).toEqual({
      set: [
        { fieldId: 'f1', value: '9500' },
        { fieldId: 'f3', value: 'UAE' },
      ],
      clear: ['f2'],
    });
  });
});

/** The contact's rows in the database; writes to `refuse` ids error. */
function fakeValues(rows: CustomValues, refuse: string[] = []) {
  const contacts = new Set<string>();
  const conflicts = new Set<string>();
  const answer = (id: string, act: () => unknown[]) => ({
    select: async () =>
      refuse.includes(id)
        ? { data: null, error: { message: 'refused' } }
        : { data: act(), error: null },
  });
  const sb = {
    from: (table: string) => {
      expect(table).toBe('contact_custom_values');
      return {
        upsert: (
          r: { contact_id: string; custom_field_id: string; value: string },
          opts: { onConflict: string }
        ) => {
          contacts.add(r.contact_id);
          conflicts.add(opts.onConflict);
          return answer(r.custom_field_id, () => {
            rows[r.custom_field_id] = r.value;
            return [{ id: `row-${r.custom_field_id}` }];
          });
        },
        delete: () => {
          const eqs: Record<string, string> = {};
          const b = {
            eq: (col: string, v: string) => {
              eqs[col] = v;
              return b;
            },
            // Without a field id this is the old delete-everything.
            select: () => {
              contacts.add(eqs.contact_id);
              const id = eqs.custom_field_id;
              return answer(id ?? '*', () => {
                const gone = Object.keys(rows).filter((k) => !id || k === id);
                for (const k of gone) delete rows[k];
                return gone.map((k) => ({ id: `row-${k}` }));
              }).select();
            },
          };
          return b;
        },
      };
    },
  };
  return { sb: sb as unknown as RowWriter, contacts, conflicts };
}

describe('saveCustomValues', () => {
  it('writes only the changed fields, on the unique key', async () => {
    // A colleague changed f2 and added f3 after this card was loaded.
    const rows = { f1: '9000', f2: 'Beta', f3: 'UAE' };
    const loaded = { f1: '9000', f2: 'Acme' };
    const { sb, contacts, conflicts } = fakeValues(rows);
    const res = await saveCustomValues(sb, 'c1', loaded, {
      ...loaded,
      f1: '9500',
    });
    expect(rows).toEqual({ f1: '9500', f2: 'Beta', f3: 'UAE' });
    expect([...contacts]).toEqual(['c1']);
    expect([...conflicts]).toEqual(['contact_id,custom_field_id']);
    expect(res).toEqual({
      values: { f1: '9500', f2: 'Acme' },
      saved: ['f1'],
      failed: [],
      missing: [],
    });
  });

  it('deletes only the cleared field', async () => {
    const rows: CustomValues = { f1: '9000', f2: 'Acme' };
    const { sb } = fakeValues(rows);
    const res = await saveCustomValues(
      sb,
      'c1',
      { ...rows },
      { f1: '', f2: 'Acme' }
    );
    expect(rows).toEqual({ f2: 'Acme' });
    expect(res.saved).toEqual(['f1']);
    expect(res.values).toEqual({ f2: 'Acme' });
  });

  it('a failed write leaves every other value and is reported', async () => {
    const rows: CustomValues = { f1: '9000', f2: 'Acme', f3: 'UAE' };
    const loaded = { ...rows };
    const draft = { f1: '9500', f2: 'Beta', f3: '' };
    const { sb } = fakeValues(rows, ['f1']);
    const res = await saveCustomValues(sb, 'c1', loaded, draft);
    expect(rows).toEqual({ f1: '9000', f2: 'Beta' });
    expect(res.failed).toEqual(['f1']);
    expect(res.saved.sort()).toEqual(['f2', 'f3']);
    // Saving again tries only what did not save.
    expect(customValueChanges(res.values, draft)).toEqual({
      set: [{ fieldId: 'f1', value: '9500' }],
      clear: [],
    });
  });

  it('a failed clear keeps the value', async () => {
    const rows: CustomValues = { f1: '9000' };
    const { sb } = fakeValues(rows, ['f1']);
    const res = await saveCustomValues(sb, 'c1', { f1: '9000' }, { f1: '' });
    expect(res.failed).toEqual(['f1']);
    expect(res.values).toEqual({ f1: '9000' });
  });

  it('a clear that found nothing is not a success', async () => {
    const { sb } = fakeValues({});
    const res = await saveCustomValues(sb, 'c1', { f1: '9000' }, { f1: '' });
    expect(res).toEqual({ values: {}, saved: [], failed: [], missing: ['f1'] });
  });
});

describe('customFieldNames', () => {
  it('names the fields in the order shown', () => {
    expect(customFieldNames(fields, ['f2', 'f1'])).toBe('Salary, Employer');
  });
});
