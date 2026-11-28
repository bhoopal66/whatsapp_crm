import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';

import { noteDrafts, noteEditKey } from '@/lib/inbox/note-drafts';
import en from '../../../messages/en.json';
import { ThreadNote } from './thread-note';

const note = {
  id: 'n1',
  account_id: 'a',
  conversation_id: 'c',
  author_id: 'u1',
  body: 'Saved words',
  mention_ids: [],
  created_at: '2026-11-24T08:00:00Z',
  edited_at: null,
  deleted_at: null,
};

function render(isMine: boolean) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <ThreadNote
        note={note}
        authorName="Sara"
        isMine={isMine}
        canManage
        nameOf={() => null}
        onEdit={async () => true}
        onDelete={async () => true}
      />
    </NextIntlClientProvider>
  );
}

describe('ThreadNote', () => {
  beforeEach(() => noteDrafts.clear('u1', noteEditKey('n1')));

  it('shows the note when no edit of it is parked', () => {
    expect(render(true)).toContain('Saved words');
    expect(render(true)).not.toContain('<textarea');
  });

  it('brings back an edit left half-written, without taking the focus', () => {
    noteDrafts.write('u1', noteEditKey('n1'), {
      text: 'Half-written',
      picked: [],
    });
    const html = render(true);
    expect(html).toMatch(/<textarea[^>]*>Half-written</);
    expect(html).not.toContain('autofocus');
    expect(render(false)).not.toContain('<textarea');
  });

  it("is kept apart from the chat's own half-written note", () => {
    noteDrafts.write('u1', 'n1', { text: 'A new note', picked: [] });
    expect(render(true)).not.toContain('A new note');
    noteDrafts.clear('u1', 'n1');
  });
});
