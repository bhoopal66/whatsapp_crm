import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import en from '../../../messages/en.json';
import {
  deleteDialogView,
  type PreviewState,
} from '@/lib/contacts/delete-preview';
import { DeleteSummary } from './delete-contacts-dialog';

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));

const targets = ['Sara', 'Ali', 'Omar', 'Mina', 'Zed'].map((name) => ({
  id: name,
  name,
}));
const held = (id: string) => ({
  id,
  legalHold: true,
  cases: 0,
  dealRooms: 0,
  submissionGroups: 0,
});
const ready = (...blocked: string[]): PreviewState => ({
  kind: 'ready',
  preview: {
    chats: 1,
    tasks: 0,
    dealRooms: 0,
    deals: 0,
    documents: 0,
    cases: 2,
    blocked: blocked.map(held),
  },
});

function text(state: PreviewState, n: number, bulk: boolean) {
  const shown = targets.slice(0, n);
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      timeZone="Asia/Dubai"
      messages={en as unknown as AbstractIntlMessages}
    >
      <DeleteSummary
        targets={shown}
        bulk={bulk}
        view={deleteDialogView(
          shown.map((c) => c.id),
          state
        )}
      />
    </NextIntlClientProvider>
  )
    .replace(/<[^>]+>/g, '|')
    .replace(/\|+/g, '|');
}

describe('delete dialog', () => {
  it('says it is checking', () => {
    expect(text({ kind: 'loading' }, 1, false)).toContain('Checking');
  });

  it('adds nothing to the plain question without the preview', () => {
    expect(text({ kind: 'failed' }, 1, false)).toBe('|');
  });

  it('shows both groups and the opt-out note', () => {
    expect(text(ready(), 1, false)).toBe(
      '|Deleted with the customer:|1 chat with its messages|Kept, without the customer:|2 cases|An opt-out or do-not-contact is remembered: it applies again if the number is added back.|'
    );
  });

  it('says why one customer stays, and nothing else', () => {
    const t = text(ready('Sara'), 1, false);
    expect(t).toContain('cannot be deleted yet:|a legal hold|');
    expect(t).not.toContain('Deleted with');
    expect(t).not.toContain('remembered');
  });

  it('names the blocked ones of a selection, then how many more', () => {
    const t = text(ready('Ali', 'Omar', 'Mina', 'Zed'), 5, true);
    expect(t).toContain('4 contacts cannot be deleted yet');
    expect(t).toContain('|Ali: a legal hold|Omar: a legal hold|Mina:');
    expect(t).toContain('|and 1 more|');
    expect(t).not.toContain('Zed');
    expect(t).toContain('Deleted with the customer:');
  });

  // No jsdom to press the buttons.
  it('is how both screens delete, by the ids the dialog offers', () => {
    const src = (path: string) =>
      readFileSync(join(process.cwd(), 'src', path), 'utf8');
    const list = src('app/(dashboard)/contacts/(list)/page.tsx');
    const header = src('components/contacts/customer/customer-header.tsx');
    expect(list.match(/<DeleteContactsDialog/g)).toHaveLength(2);
    expect(list.match(/await deleteContacts\(supabase, ids\)/g)).toHaveLength(
      2
    );
    expect(list).toContain('stayedText(res,');
    expect(header).toContain('<DeleteContactsDialog');
    expect(header).toContain('await deleteContacts(createClient(), ids)');
    const dialog = src('components/contacts/delete-contacts-dialog.tsx');
    expect(dialog).toContain('onDelete(view.deletable)');
    expect(dialog).toContain('disabled={deleting || view.loading}');
  });
});
