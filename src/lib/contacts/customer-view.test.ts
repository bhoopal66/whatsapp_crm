import { describe, expect, it } from 'vitest';

import { sessionKey } from '@/lib/session-cache';

import type { Basics, CustomerTimeline } from './customer-load';
import {
  EMPTY_CUSTOMER_VIEW,
  applyPart,
  cacheAction,
  customerSections,
  customerViewKey,
  startView,
  viewOwner,
  worthCaching,
  type CustomerView,
} from './customer-view';

const basics = {
  contact: { id: 'c1', name: 'Ana' },
  conversation: null,
  insights: null,
  deal: null,
  draftOn: false,
} as unknown as Basics;
const timeline = {
  rows: { calls: [], messages: [], notes: [], internal: [] },
  paging: {},
} as unknown as CustomerTimeline;

describe('customerViewKey', () => {
  it('names account, user and contact', () => {
    expect(customerViewKey('a1', 'u1', 'c1')).toBe(
      sessionKey('a1', 'u1', 'contact:c1')
    );
  });
  it('is null until account and user are known', () => {
    expect(customerViewKey(null, 'u1', 'c1')).toBeNull();
    expect(customerViewKey('a1', undefined, 'c1')).toBeNull();
  });
  it('is not under the contacts list prefix', () => {
    const list = sessionKey('a1', 'u1', 'contacts:list:')!;
    expect(customerViewKey('a1', 'u1', 'c1')!.startsWith(list)).toBe(false);
  });
});

describe('customerSections', () => {
  it('mounts the self-loading cards while the basics load', () => {
    const s = customerSections(EMPTY_CUSTOMER_VIEW);
    expect(s).toMatchObject({
      page: 'loading',
      header: 'loading',
      timeline: 'loading',
      selfLoading: true,
    });
  });
  it('shows the header on the basics alone', () => {
    const s = customerSections(
      applyPart(EMPTY_CUSTOMER_VIEW, { kind: 'basics', value: basics })
    );
    expect(s).toMatchObject({
      page: 'ready',
      header: 'ready',
      timeline: 'loading',
    });
  });
  it('holds the timeline until the basics land', () => {
    const v = applyPart(EMPTY_CUSTOMER_VIEW, {
      kind: 'timeline',
      value: timeline,
    });
    expect(customerSections(v).timeline).toBe('loading');
    expect(
      customerSections(applyPart(v, { kind: 'basics', value: basics })).timeline
    ).toBe('ready');
  });
  it('replaces the page for a missing contact', () => {
    const s = customerSections(
      applyPart(EMPTY_CUSTOMER_VIEW, { kind: 'basics', value: null })
    );
    expect(s.page).toBe('missing');
    expect(s.selfLoading).toBe(false);
  });
  it('fails the page only on the basics', () => {
    const v = applyPart(EMPTY_CUSTOMER_VIEW, {
      kind: 'failed',
      part: 'timeline',
    });
    expect(customerSections(v)).toMatchObject({
      page: 'loading',
      timeline: 'failed',
    });
    expect(
      customerSections(applyPart(v, { kind: 'failed', part: 'basics' })).page
    ).toBe('failed');
  });
});

describe('applyPart', () => {
  const held: CustomerView = {
    ...EMPTY_CUSTOMER_VIEW,
    basics,
    timeline,
    tasks: [],
  };
  it('keeps what is on screen when a refresh fails', () => {
    for (const part of ['basics', 'timeline', 'tasks'] as const)
      expect(applyPart(held, { kind: 'failed', part })).toBe(held);
  });
  it('settles tasks empty when nothing was held', () => {
    expect(
      applyPart(EMPTY_CUSTOMER_VIEW, { kind: 'failed', part: 'tasks' }).tasks
    ).toEqual([]);
  });
  it('turns a held contact missing when the refresh finds none', () => {
    const v = applyPart(held, { kind: 'basics', value: null });
    expect(v.missing).toBe(true);
    expect(customerSections(v).page).toBe('missing');
  });
  it('merges names', () => {
    const v = applyPart(
      { ...EMPTY_CUSTOMER_VIEW, names: { u1: 'A' } },
      { kind: 'names', value: { u2: 'B' } }
    );
    expect(v.names).toEqual({ u1: 'A', u2: 'B' });
  });
});

describe('startView and worthCaching', () => {
  it('starts a revisit from the cached view, failures cleared', () => {
    const cached = {
      ...EMPTY_CUSTOMER_VIEW,
      basics,
      failed: { basics: false, timeline: true },
    };
    const v = startView(cached);
    expect(v.basics).toBe(basics);
    expect(customerSections(v).timeline).toBe('loading');
  });
  it('starts empty with nothing cached', () => {
    expect(startView(undefined)).toBe(EMPTY_CUSTOMER_VIEW);
  });
  it('caches only a view that holds the basics or a missing answer', () => {
    expect(worthCaching(EMPTY_CUSTOMER_VIEW)).toBe(false);
    expect(worthCaching({ ...EMPTY_CUSTOMER_VIEW, basics })).toBe(true);
    expect(worthCaching({ ...EMPTY_CUSTOMER_VIEW, missing: true })).toBe(true);
  });
});

describe('viewOwner and cacheAction', () => {
  const k1 = customerViewKey('a1', 'u1', 'c1')!;
  const k2 = customerViewKey('a1', 'u2', 'c1')!;
  const kc2 = customerViewKey('a1', 'u1', 'c2')!;
  const held: CustomerView = { ...EMPTY_CUSTOMER_VIEW, basics };

  it('owns the first non-null key seen for the contact', () => {
    expect(viewOwner(null, 'c1', null)).toBeNull();
    const o = viewOwner(null, 'c1', k1);
    expect(o).toEqual({ contactId: 'c1', key: k1 });
    expect(viewOwner(o, 'c1', k2)).toBe(o);
    expect(viewOwner(o, 'c1', null)).toBe(o);
  });
  it('starts over for another contact', () => {
    const o = viewOwner(null, 'c1', k1);
    expect(viewOwner(o, 'c2', kc2)).toEqual({ contactId: 'c2', key: kc2 });
    expect(viewOwner(o, 'c2', null)).toBeNull();
  });
  it('stores a view worth keeping under the owner key only', () => {
    const o = viewOwner(null, 'c1', k1);
    expect(cacheAction(held, k1, o)).toBe('store');
    expect(cacheAction(held, k2, o)).toBe('none');
    expect(cacheAction(held, null, o)).toBe('none');
    expect(cacheAction(held, k1, null)).toBe('none');
    expect(cacheAction(EMPTY_CUSTOMER_VIEW, k1, o)).toBe('none');
  });
  it('drops the entry of a missing contact, never stores it', () => {
    const o = viewOwner(null, 'c1', k1);
    const gone = applyPart(held, { kind: 'basics', value: null });
    expect(cacheAction(gone, k1, o)).toBe('drop');
    expect(cacheAction(gone, k2, o)).toBe('none');
  });
});
