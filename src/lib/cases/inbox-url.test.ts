import { describe, expect, it } from 'vitest';

import {
  commitDraft,
  initialInboxUrl,
  inboxUrlSearch,
  reconcileInboxUrl,
  settleInboxUrl,
  typeDraft,
  writeFilters,
} from './inbox-url';
import { EMPTY_FILTERS } from './ui';
import { inboxFiltersFromView } from './views-ui';

const start = (search = '') => initialInboxUrl(search);

describe('fast typing', () => {
  it('keeps what is typed while an earlier commit lands', () => {
    let s = commitDraft(typeDraft(start(), 'al'));
    expect(inboxUrlSearch(s)).toBe('q=al');
    s = typeDraft(s, 'alpha');
    s = reconcileInboxUrl(s, 'q=al');
    expect(s.draft).toBe('alpha');
    s = commitDraft(s);
    expect(inboxUrlSearch(s)).toBe('q=alpha');
  });

  it('keeps the newer commit when the older one lands after it', () => {
    let s = commitDraft(typeDraft(start(), 'al'));
    s = commitDraft(typeDraft(s, 'alpha'));
    s = reconcileInboxUrl(s, 'q=al');
    expect([s.draft, s.filters.q]).toEqual(['alpha', 'alpha']);
    s = reconcileInboxUrl(s, 'q=alpha');
    expect([s.draft, s.filters.q, s.own]).toEqual(['alpha', 'alpha', []]);
  });
});

describe('filter clicks', () => {
  it('a bank picked before q lands keeps q', () => {
    let s = commitDraft(typeDraft(start(), 'ali'));
    s = writeFilters(s, { bank: 'RAK' });
    expect(inboxUrlSearch(s)).toBe('q=ali&bank=RAK');
  });

  it('a bank picked before the pause takes the typed text along', () => {
    const s = writeFilters(typeDraft(start(), 'ali'), { bank: 'RAK' });
    expect(inboxUrlSearch(s)).toBe('q=ali&bank=RAK');
    expect(commitDraft(s)).toBe(s);
  });

  it('a search committed before a bank lands keeps the bank', () => {
    let s = writeFilters(start(), { bank: 'RAK' });
    s = commitDraft(typeDraft(s, 'ali'));
    expect(inboxUrlSearch(s)).toBe('q=ali&bank=RAK');
  });

  it('two quick filters both hold, and My team is left by naming an agent', () => {
    let s = writeFilters(start('team=1'), { bank: 'RAK' });
    s = writeFilters(s, { priority: 'high' });
    expect(inboxUrlSearch(s)).toBe('bank=RAK&priority=high&team=1');
    expect(writeFilters(s, { agent: null }).team).toBe(false);
    expect(writeFilters(start(), { agent: null }, true).team).toBe(true);
  });

  it('writing the same value writes nothing', () => {
    const s = start('bank=RAK');
    expect(writeFilters(s, { bank: 'RAK' })).toBe(s);
  });
});

describe('changes from outside', () => {
  it('Back puts the box and the filters on the URL it returns to', () => {
    let s = reconcileInboxUrl(
      commitDraft(typeDraft(start('bank=RAK'), 'ali')),
      'q=ali&bank=RAK'
    );
    s = reconcileInboxUrl(s, 'bank=RAK');
    expect([s.draft, s.filters.q, s.filters.bank]).toEqual(['', null, 'RAK']);
    s = reconcileInboxUrl(s, 'bank=RAK&q=ali');
    expect([s.draft, s.filters.q]).toEqual(['ali', 'ali']);
  });

  it('keeps text being typed when another filter changes outside', () => {
    const s = reconcileInboxUrl(typeDraft(start(), 'al'), 'bank=RAK');
    expect([s.draft, s.filters.bank]).toEqual(['al', 'RAK']);
  });

  it('a write never read back does not swallow a later Back to it', () => {
    // On and off again: only the last of the two is ever rendered.
    let s = writeFilters(start(), { bankQueryOpen: true });
    s = settleInboxUrl(writeFilters(s, { bankQueryOpen: false }));
    s = reconcileInboxUrl(s, 'bank_query_open=true');
    expect(s.filters.bankQueryOpen).toBe(true);
  });
});

describe('saved view and Clear', () => {
  it('a saved view applied while typing replaces the typed text', () => {
    let s = commitDraft(typeDraft(start(), 'al'));
    s = typeDraft(s, 'alpha');
    const { sort: _s, q: _q, ...base } = EMPTY_FILTERS;
    void _s;
    void _q;
    s = writeFilters(
      s,
      inboxFiltersFromView({ filters: { ...base, bank: 'RAK' }, sort: null })
    );
    s = reconcileInboxUrl(s, 'q=al');
    expect([s.draft, inboxUrlSearch(s)]).toEqual(['', 'bank=RAK']);
    expect(commitDraft(s)).toBe(s);
    expect(reconcileInboxUrl(s, 'bank=RAK').draft).toBe('');
  });

  it('Clear empties the box even when nothing was committed', () => {
    const s = writeFilters(typeDraft(start(), 'al'), EMPTY_FILTERS);
    expect([s.draft, inboxUrlSearch(s)]).toEqual(['', '']);
  });
});
