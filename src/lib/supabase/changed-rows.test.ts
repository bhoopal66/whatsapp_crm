import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  bulkAnswer,
  deleteRows,
  rowWrite,
  updateRow,
  type RowWriter,
} from './changed-rows';

/** Records the chain; answers `result` once awaited. */
function fakeWriter(result: { data: unknown; error: unknown }) {
  const ops: unknown[][] = [];
  const builder: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown) => Promise.resolve(result).then(ok),
  };
  for (const m of ['update', 'delete', 'eq', 'in', 'select'])
    builder[m] = (...args: unknown[]) => {
      ops.push([m, ...args]);
      return builder;
    };
  const sb = {
    from: (table: string) => {
      ops.push(['from', table]);
      return builder;
    },
  };
  return { sb: sb as unknown as RowWriter, ops };
}

const refused = { code: '42501', message: 'denied', hint: 'LEGAL_HOLD' };

describe('updateRow / deleteRows', () => {
  it('asks for the changed row back', async () => {
    const { sb, ops } = fakeWriter({ data: [{ id: 'd1' }], error: null });
    expect(await updateRow(sb, 'deals', 'd1', { status: 'won' })).toEqual({
      kind: 'changed',
      ids: ['d1'],
    });
    expect(ops).toEqual([
      ['from', 'deals'],
      ['update', { status: 'won' }],
      ['eq', 'id', 'd1'],
      ['select', 'id'],
    ]);
  });

  it('answers none when RLS filtered the row out or it is gone', async () => {
    const { sb, ops } = fakeWriter({ data: [], error: null });
    expect(await deleteRows(sb, 'contacts', ['c1'])).toEqual({ kind: 'none' });
    expect(await updateRow(sb, 'deals', 'd1', {})).toEqual({ kind: 'none' });
    expect(ops.slice(0, 4)).toEqual([
      ['from', 'contacts'],
      ['delete'],
      ['in', 'id', ['c1']],
      ['select', 'id'],
    ]);
  });

  it('answers the rows really deleted', async () => {
    const { sb } = fakeWriter({ data: [{ id: 'a' }], error: null });
    expect(await deleteRows(sb, 'contacts', ['a', 'b'])).toEqual({
      kind: 'changed',
      ids: ['a'],
    });
  });

  it('keeps the error, hint included', async () => {
    const { sb } = fakeWriter({ data: null, error: refused });
    expect(await deleteRows(sb, 'contacts', ['a'])).toEqual({
      kind: 'failed',
      error: refused,
    });
  });

  it('never reads a missing body as a success', () => {
    expect(rowWrite({ data: null, error: null })).toEqual({ kind: 'none' });
  });
});

describe('bulkAnswer', () => {
  it('counts real rows', () => {
    expect(bulkAnswer(3, 3)).toEqual({ kind: 'all', count: 3 });
    expect(bulkAnswer(3, 1)).toEqual({ kind: 'some', count: 1, total: 3 });
    expect(bulkAnswer(3, 0)).toEqual({ kind: 'none' });
  });
});

// The screens that edit customers and deals (no jsdom to drive them):
// a bare `.update()` / `.delete()` there reports success on 0 rows.
describe('customer and deal screens', () => {
  const read = (path: string) =>
    readFileSync(join(process.cwd(), 'src', path), 'utf8');

  it.each([
    'app/(dashboard)/contacts/(list)/page.tsx',
    'app/(dashboard)/pipelines/page.tsx',
    'components/contacts/contact-form.tsx',
    'components/contacts/customer-page.tsx',
    'components/contacts/customer/customer-cards.tsx',
    'components/contacts/customer/customer-header.tsx',
    'components/pipelines/deal-form.tsx',
  ])('%s writes only through the counted helpers', (path) => {
    expect(read(path)).not.toMatch(
      /\.from\(\s*'[a-z_]+'\s*\)\s*\.(update|delete|upsert)\(/
    );
  });

  it.each([
    ['app/(dashboard)/contacts/(list)/page.tsx', 'toastNotDeleted'],
    ['app/(dashboard)/contacts/(list)/page.tsx', 'toastBulkDeletedSome'],
    ['app/(dashboard)/contacts/(list)/page.tsx', 'toastBulkNotDeleted'],
    ['app/(dashboard)/pipelines/page.tsx', 'toastDealNotMoved'],
    ['components/contacts/contact-form.tsx', 'toastNotSaved'],
    ['components/contacts/customer-page.tsx', 'toastNoteNotDeleted'],
    [
      'components/contacts/customer/customer-cards.tsx',
      'customFieldsLoadFailed',
    ],
    [
      'components/contacts/customer/customer-cards.tsx',
      'toastCustomFieldsGone',
    ],
    ['components/contacts/customer/customer-header.tsx', 'toastNotDeleted'],
    ['components/pipelines/deal-form.tsx', 'toastNotSaved'],
    ['components/pipelines/deal-form.tsx', 'toastNotDeleted'],
  ])('%s tells the person (%s)', (path, key) => {
    expect(read(path)).toContain(`'${key}'`);
  });
});
