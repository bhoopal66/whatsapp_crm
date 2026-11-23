import { describe, expect, it } from 'vitest';

import type { RowWriter } from '@/lib/supabase/changed-rows';
import type { CustomField } from '@/types';

import {
  checkFieldName,
  deleteField,
  loadFieldList,
  renameField,
  type FieldList,
} from './custom-fields';

/** A query whose every method returns itself and awaits to `result`. */
function fake(data: unknown, error: unknown = null) {
  const q: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown) =>
      Promise.resolve({ data, error }).then(ok),
  };
  for (const m of ['select', 'order', 'update', 'delete', 'eq', 'in'])
    q[m] = () => q;
  return { from: () => q } as unknown as RowWriter;
}

const field = (id: string, field_name: string) =>
  ({ id, field_name }) as CustomField;

describe('loadFieldList', () => {
  it('a failed read is failed, never an empty list', async () => {
    expect(await loadFieldList(fake(null, { message: 'timeout' }))).toEqual({
      status: 'failed',
    });
    expect(await loadFieldList(fake([]))).toEqual({
      status: 'ready',
      fields: [],
    });
  });
});

describe('checkFieldName', () => {
  const ready: FieldList = {
    status: 'ready',
    fields: [field('1', 'Salary'), field('2', 'City')],
  };

  it('finds a clash whatever the case, bar the field itself', () => {
    expect(checkFieldName(ready, 'salary')).toBe('taken');
    expect(checkFieldName(ready, 'salary', '1')).toBe('free');
    expect(checkFieldName(ready, 'Company')).toBe('free');
  });

  it.each(['loading', 'failed'] as const)(
    'is unknown, not free, while the list is %s',
    (status) => {
      expect(checkFieldName({ status }, 'Salary')).toBe('unknown');
    }
  );
});

describe('renameField / deleteField', () => {
  it('a write that changed no row is an error', async () => {
    expect(await renameField(fake([]), '1', 'x')).toBe('toastNotRenamed');
    expect(await deleteField(fake([]), '1')).toBe('toastNotDeleted');
  });

  it('a refused write is its own error, a changed row none', async () => {
    const refused = fake(null, { code: '42501' });
    expect(await renameField(refused, '1', 'x')).toBe('toastRenameFailed');
    expect(await deleteField(refused, '1')).toBe('toastDeleteFailed');
    const done = fake([{ id: '1' }]);
    expect(await renameField(done, '1', 'x')).toBeNull();
    expect(await deleteField(done, '1')).toBeNull();
  });
});
