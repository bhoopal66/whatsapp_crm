import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../../../messages/en.json';
import { SortPicker } from './sort-picker';

const html = (props: Partial<Parameters<typeof SortPicker>[0]> = {}) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <SortPicker
        current={{ sort: 'activity', dir: 'desc' }}
        onSort={vi.fn()}
        {...props}
      />
    </NextIntlClientProvider>
  );

describe('SortPicker (the sort control below the column headers)', () => {
  it('shows the current key and a direction button for it', () => {
    const out = html();
    expect(out).toContain('Last activity');
    expect(out).toContain('aria-label="Sort by"');
    expect(out).toContain('Descending. Tap to sort ascending.');
  });

  it('says ascending when the sort is ascending', () => {
    expect(html({ current: { sort: 'owner', dir: 'asc' } })).toContain(
      'Ascending. Tap to sort descending.'
    );
  });

  it('disables both controls while results are ranked by search', () => {
    const out = html({ disabled: true });
    expect(out.match(/disabled/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(out).toContain('ordered by best match');
  });

  it('explains a missing migration', () => {
    expect(html({ serverSortMissing: true })).toContain('database update');
  });
});
