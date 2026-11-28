import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Below `lg` the column headers past Name are hidden, so this control is
// the only way to sort there. Server-rendered: the control exists, is
// hidden from `lg` up, offers the shown columns and reflects the sort.

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

import { MobileSort } from './mobile-sort';

const noop = () => {};

describe('MobileSort', () => {
  it('renders only below lg, with one option per key', () => {
    const html = renderToStaticMarkup(
      <MobileSort
        keys={['name', 'owner', 'created']}
        current={{ sort: 'created', dir: 'desc' }}
        onChange={noop}
      />
    );
    expect(html).toContain('lg:hidden');
    expect(html).toContain('ContactsTable.sortBy');
    const values = [...html.matchAll(/<option value="(\w+)"/g)].map(
      (m) => m[1]
    );
    expect(values).toEqual(['name', 'owner', 'created']);
    expect(html).toContain('Contacts.page.tableColumns.createdAt');
    expect(html).toMatch(/<option value="created" selected/);
  });

  it('labels the direction button with the action it takes', () => {
    const desc = renderToStaticMarkup(
      <MobileSort
        keys={['name']}
        current={{ sort: 'name', dir: 'desc' }}
        onChange={noop}
      />
    );
    expect(desc).toContain('aria-label="ContactsTable.sortAscending"');
    const asc = renderToStaticMarkup(
      <MobileSort
        keys={['name']}
        current={{ sort: 'name', dir: 'asc' }}
        onChange={noop}
      />
    );
    expect(asc).toContain('aria-label="ContactsTable.sortDescending"');
  });

  it('disables the field while ranked by search, and server-only keys without the RPC', () => {
    const ranked = renderToStaticMarkup(
      <MobileSort
        keys={['name']}
        current={{ sort: 'name', dir: 'asc' }}
        onChange={noop}
        disabled
      />
    );
    expect(ranked).toMatch(/<select[^>]*disabled/);
    const missing = renderToStaticMarkup(
      <MobileSort
        keys={['name', 'owner', 'created']}
        current={{ sort: 'name', dir: 'asc' }}
        onChange={noop}
        serverSortMissing
      />
    );
    expect(missing).toMatch(/<option value="owner" disabled/);
    expect(missing).not.toMatch(/<option value="created" disabled/);
  });
});
