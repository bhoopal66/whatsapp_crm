import { describe, expect, it } from 'vitest';

import { BRAIN_SOURCE_KINDS } from './ports';
import {
  BRAIN_QUERY_MAX,
  BRAIN_QUERY_MIN,
  BRAIN_UI_SOURCE_KINDS,
  hitHref,
  isBrainDisabled,
  parseCaseScope,
  parseSearchHits,
  queryProblem,
  rememberCaseOptions,
} from './ui';

describe('queryProblem', () => {
  it('asks for at least 2 characters after trimming', () => {
    expect(BRAIN_QUERY_MIN).toBe(2);
    expect(queryProblem('')).toBe('short');
    expect(queryProblem('a')).toBe('short');
    expect(queryProblem('  a  ')).toBe('short');
    expect(queryProblem('ab')).toBeNull();
    expect(queryProblem(' statements ')).toBeNull();
  });
  it('refuses more than 300 characters', () => {
    expect(BRAIN_QUERY_MAX).toBe(300);
    expect(queryProblem('x'.repeat(300))).toBeNull();
    expect(queryProblem('x'.repeat(301))).toBe('long');
  });
});

describe('hitHref', () => {
  it('links a case hit to its case page; a workspace hit has no link', () => {
    expect(hitHref({ caseId: 'TC-24102' })).toBe('/cases/TC-24102');
    expect(hitHref({ caseId: 'TC-1/x y' })).toBe('/cases/TC-1%2Fx%20y');
    expect(hitHref({ caseId: null })).toBeNull();
  });
});

describe('rememberCaseOptions', () => {
  it('scoped case first, then distinct hit cases in order, workspace hits skipped', () => {
    const hits = [
      { caseId: 'TC-2' },
      { caseId: null },
      { caseId: 'TC-1' },
      { caseId: 'TC-2' },
      { caseId: 'TC-9' },
    ];
    expect(rememberCaseOptions(hits)).toEqual(['TC-2', 'TC-1', 'TC-9']);
    expect(rememberCaseOptions(hits, 'TC-1')).toEqual(['TC-1', 'TC-2', 'TC-9']);
    expect(rememberCaseOptions([], 'TC-5')).toEqual(['TC-5']);
    expect(rememberCaseOptions([])).toEqual([]);
  });
});

describe('BRAIN_UI_SOURCE_KINDS', () => {
  it('equals the server list', () => {
    expect([...BRAIN_UI_SOURCE_KINDS]).toEqual([...BRAIN_SOURCE_KINDS]);
  });
});

describe('parseCaseScope', () => {
  it('keeps a UUID and drops anything else', () => {
    const id = '0b5f3c1e-7a2d-4c8e-9f10-123456789abc';
    expect(parseCaseScope(id)).toBe(id);
    expect(parseCaseScope(` ${id} `)).toBe(id);
    expect(parseCaseScope('TC-1')).toBeNull();
    expect(parseCaseScope('')).toBeNull();
    expect(parseCaseScope(null)).toBeNull();
  });
});

describe('parseSearchHits', () => {
  it('keeps well-formed hits, drops the score and bad rows', () => {
    const body = {
      hits: [
        {
          itemId: 'a',
          snippet: 'statement [phone]',
          sourceKind: 'note',
          caseId: 'c1',
          score: 0.9,
          aiGenerated: false,
          citation: { kind: 'note', id: 'n1' },
        },
        {
          itemId: 'b',
          snippet: 's',
          sourceKind: 'page',
          caseId: null,
          aiGenerated: true,
        },
        { itemId: 'c', snippet: 's', sourceKind: 'bogus', caseId: null },
        { itemId: 4, snippet: 's', sourceKind: 'note', caseId: null },
        null,
      ],
    };
    expect(parseSearchHits(body)).toEqual([
      {
        itemId: 'a',
        snippet: 'statement [phone]',
        sourceKind: 'note',
        caseId: 'c1',
        aiGenerated: false,
      },
      {
        itemId: 'b',
        snippet: 's',
        sourceKind: 'page',
        caseId: null,
        aiGenerated: true,
      },
    ]);
  });
  it('null on a bad shape', () => {
    expect(parseSearchHits(null)).toBeNull();
    expect(parseSearchHits({ hits: 'x' })).toBeNull();
    expect(parseSearchHits({ hits: [] })).toEqual([]);
  });
});

describe('isBrainDisabled', () => {
  it('is only the 403 brain_disabled answer', () => {
    expect(isBrainDisabled(403, { error: 'brain_disabled' })).toBe(true);
    expect(isBrainDisabled(403, { error: 'forbidden' })).toBe(false);
    expect(isBrainDisabled(500, { error: 'brain_disabled' })).toBe(false);
    expect(isBrainDisabled(403, null)).toBe(false);
  });
});
