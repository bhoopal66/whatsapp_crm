import { describe, expect, it } from 'vitest';
import {
  chunkIds,
  conversationContactGroup,
  conversationTextGroup,
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

describe('conversation search groups', () => {
  it('match the found contacts, and the last message, apart', () => {
    expect(conversationContactGroup(['1', '2'])).toBe('contact_id.in.(1,2)');
    expect(conversationContactGroup([])).toBeNull();
    expect(conversationTextGroup('acme')).toBe(
      'last_message_text.ilike.%acme%'
    );
  });

  it('strip or syntax, escape wildcards, and drop empty terms', () => {
    expect(conversationTextGroup('a,(b)')).toBe(
      'last_message_text.ilike.%a  b%'
    );
    expect(conversationTextGroup('50%_off*')).toBe(
      'last_message_text.ilike.%50\\%\\_off%'
    );
    expect(conversationTextGroup('  ')).toBeNull();
    expect(conversationTextGroup('%%%%')).toBeNull();
  });
});

describe('chunkIds', () => {
  it('slices into at most the given size', () => {
    expect(chunkIds(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
    expect(chunkIds([], 2)).toEqual([]);
    expect(
      chunkIds(Array.from({ length: 300 }, (_, i) => String(i))).map(
        (c) => c.length
      )
    ).toEqual([150, 150]);
  });
});
