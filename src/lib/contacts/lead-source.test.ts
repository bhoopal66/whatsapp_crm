import { describe, expect, it } from 'vitest';
import {
  isLeadSource,
  leadSourceFilter,
  leadSourceOf,
  LEAD_SOURCES,
  parseLeadSources,
} from './lead-source';

describe('parseLeadSources', () => {
  it('keeps known values once, in canonical order', () => {
    expect(parseLeadSources('import, ad,ghost,ad')).toEqual(['ad', 'import']);
    expect(parseLeadSources(['other', 'web_form', 3])).toEqual([
      'web_form',
      'other',
    ]);
  });
  it('accepts nothing gracefully', () => {
    expect(parseLeadSources(null)).toEqual([]);
    expect(parseLeadSources('')).toEqual([]);
  });
});

describe('leadSourceFilter', () => {
  it('builds an any-of group', () => {
    expect(leadSourceFilter(['web_form', 'ad'])).toBe(
      'lead_source.in.(ad,web_form)'
    );
  });
  it('is null for none and never carries unknown text', () => {
    expect(leadSourceFilter([])).toBeNull();
    expect(leadSourceFilter(['ad),name.eq.x'])).toBeNull();
  });
  it('covers every source', () => {
    expect(leadSourceFilter(LEAD_SOURCES)).toContain('compass');
  });
});

describe('leadSourceOf', () => {
  it('is null for missing or unknown values', () => {
    expect(leadSourceOf({})).toBeNull();
    expect(leadSourceOf({ lead_source: 'tiktok' })).toBeNull();
    expect(leadSourceOf({ lead_source: 'ad' })).toBe('ad');
    expect(isLeadSource('ad')).toBe(true);
  });
});
