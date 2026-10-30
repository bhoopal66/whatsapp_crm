import { describe, expect, it } from 'vitest';
import {
  panelPartKey,
  panelRowKey,
  panelSource,
  prependNote,
} from '@/lib/inbox/contact-panel';
import type { ConversationListItem } from '@/lib/inbox/conversations';
import type { ContactNote, Conversation } from '@/types';

const listContact = {
  id: 'k1',
  name: 'Sara',
  phone: '+971500000001',
  company: 'Acme',
  avatar_url: null,
};
const listRow = {
  id: 'c1',
  contact: listContact,
} as unknown as ConversationListItem;
const fullContact = { ...listContact, email: 's@acme.ae', opted_out_at: null };
const fullRow = { id: 'c1', contact: fullContact } as unknown as Conversation;

describe('panel keys', () => {
  it('name account, user, conversation and (for parts) contact', () => {
    expect(panelRowKey('a', 'u', 'c1')).toBe('s:a:u:inbox:panel:c1');
    expect(panelPartKey('a', 'u', 'c1', 'notes', 'k1')).toBe(
      's:a:u:inbox:panel:c1:notes:k1'
    );
    expect(panelPartKey('a', 'u', 'c1', 'deals', 'k2')).not.toBe(
      panelPartKey('a', 'u', 'c1', 'deals', 'k1')
    );
  });

  it('are null until everything they name is known', () => {
    expect(panelRowKey('a', 'u', null)).toBeNull();
    expect(panelRowKey(null, 'u', 'c1')).toBeNull();
    expect(panelPartKey('a', 'u', 'c1', 'deals', undefined)).toBeNull();
    expect(panelPartKey('a', null, 'c1', 'deals', 'k1')).toBeNull();
  });
});

describe('panelSource', () => {
  it('shows nothing with no chat open', () => {
    expect(panelSource({ open: null, full: null, cached: fullRow })).toEqual({
      complete: false,
      contact: null,
      conversation: null,
    });
  });

  it('shows the list row contact while the full row is in flight', () => {
    const s = panelSource({ open: listRow, full: null, cached: undefined });
    expect(s.complete).toBe(false);
    expect(s.contact).toBe(listContact);
    expect(s.conversation).toBeNull();
  });

  it('shows the cached full row of the same chat on a revisit', () => {
    const s = panelSource({ open: listRow, full: null, cached: fullRow });
    expect(s.complete).toBe(true);
    expect(s.contact).toBe(fullContact);
    expect(s.conversation).toBe(fullRow);
  });

  it('never shows another chat cached under a stale read', () => {
    const other = { ...fullRow, id: 'c2' } as Conversation;
    const s = panelSource({ open: listRow, full: null, cached: other });
    expect(s.contact).toBe(listContact);
    expect(s.conversation).toBeNull();
  });

  it('prefers the live full row over the cached one', () => {
    const cached = {
      ...fullRow,
      contact: { ...fullContact, email: 'old@acme.ae' },
    } as unknown as Conversation;
    const s = panelSource({ open: fullRow, full: fullRow, cached });
    expect(s.contact?.email).toBe('s@acme.ae');
    expect(s.conversation).toBe(fullRow);
  });
});

describe('prependNote', () => {
  const note = (id: string) => ({ id, note_text: id }) as ContactNote;

  it('puts the new note first', () => {
    expect(prependNote([note('a')], note('b')).map((n) => n.id)).toEqual([
      'b',
      'a',
    ]);
  });

  it('does not double a note a refresh already brought', () => {
    expect(
      prependNote([note('b'), note('a')], note('b')).map((n) => n.id)
    ).toEqual(['b', 'a']);
  });
});
