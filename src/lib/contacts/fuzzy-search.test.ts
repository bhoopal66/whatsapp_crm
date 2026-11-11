import { describe, expect, it } from 'vitest';
import {
  conversationSearchGroup,
  isMissingSearchRpc,
  parseSearchHits,
  rankByHits,
  searchRpcTerm,
} from './fuzzy-search';

describe('searchRpcTerm', () => {
  it('sends a cleaned term of 2+ characters, else null', () => {
    expect(searchRpcTerm('  Acme, Inc ')).toBe('Acme  Inc');
    expect(searchRpcTerm('a')).toBeNull();
    expect(searchRpcTerm(' ( ')).toBeNull();
  });
});

describe('isMissingSearchRpc', () => {
  it('is true only for a missing function', () => {
    expect(isMissingSearchRpc({ code: 'PGRST202' })).toBe(true);
    expect(isMissingSearchRpc({ code: '42883' })).toBe(true);
    expect(isMissingSearchRpc({ code: '57014' })).toBe(false);
    expect(isMissingSearchRpc(null)).toBe(false);
  });
});

describe('parseSearchHits', () => {
  it('keeps well-formed rows, exact first then by score, deduped', () => {
    const hits = parseSearchHits([
      { contact_id: 'c', score: 0.9, exact: false },
      { contact_id: 'a', score: 0.4, exact: true },
      { contact_id: 'b', score: 0.95, exact: false },
      { contact_id: 'a', score: 1, exact: true },
      { score: 1, exact: true },
      null,
    ]);
    expect(hits.map((h) => h.contactId)).toEqual(['a', 'b', 'c']);
    expect(hits[0]).toEqual({ contactId: 'a', score: 0.4, exact: true });
  });

  it('is empty for a non-array', () => {
    expect(parseSearchHits(null)).toEqual([]);
  });
});

describe('rankByHits', () => {
  it('orders rows by rank, marks close matches and drops unranked rows', () => {
    const rows = [{ id: 'x' }, { id: 'b' }, { id: 'a' }];
    const ranked = rankByHits(rows, [
      { contactId: 'a', score: 1, exact: true },
      { contactId: 'b', score: 0.5, exact: false },
      { contactId: 'gone', score: 0.4, exact: false },
    ]);
    expect(ranked).toEqual([
      { id: 'a', closeMatch: false },
      { id: 'b', closeMatch: true },
    ]);
  });
});

describe('conversationSearchGroup', () => {
  it('matches the found contacts or the last message', () => {
    expect(conversationSearchGroup('acme', ['1', '2'])).toBe(
      'contact_id.in.(1,2),last_message_text.ilike.%acme%'
    );
  });

  it('keeps only the message branch with no contacts, and strips or syntax', () => {
    expect(conversationSearchGroup('a,(b)', [])).toBe(
      'last_message_text.ilike.%a  b%'
    );
    expect(conversationSearchGroup('  ', ['1'])).toBeNull();
  });
});
