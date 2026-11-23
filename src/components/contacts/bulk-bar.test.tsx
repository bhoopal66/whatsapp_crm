import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';

import en from '../../../messages/en.json';
import { BulkBar } from './bulk-bar';

vi.mock('@/hooks/use-can', () => ({ useCan: () => true }));

const render = (canDelete: boolean) =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={en as unknown as AbstractIntlMessages}
    >
      <BulkBar
        count={2}
        canAct
        canDelete={canDelete}
        tree={{ mains: [] } as never}
        onClear={() => {}}
        onDelete={() => {}}
        onApplyTag={async () => {}}
        onAddToCampaign={() => {}}
      />
    </NextIntlClientProvider>
  );

describe('BulkBar', () => {
  it('offers delete only to those who may delete a customer', () => {
    const label = en.Contacts.page.deleteSelected;
    expect(render(true)).toContain(label);
    expect(render(false)).not.toContain(label);
  });

  it('keeps the rest of the bar for everyone', () => {
    const html = render(false);
    expect(html).toContain(en.ContactsTable.setChatTag);
    expect(html).toContain(en.ContactsTable.addToCampaign);
    expect(html).toContain(en.Contacts.page.clearSelection);
  });
});
