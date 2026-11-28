import { describe, expect, it } from 'vitest';
import {
  isLeadSource,
  leadSourceFilter,
  leadSourceOf,
  LEAD_SOURCES,
  parseLeadSources,
  parseSourceFilter,
  sourceFilterParts,
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

describe('the Unknown source filter value', () => {
  it('is kept by the filter parser, last, and nothing else unknown is', () => {
    expect(parseSourceFilter('unknown,ad,ghost')).toEqual(['ad', 'unknown']);
    expect(parseSourceFilter(['web_form', 'unknown', 7])).toEqual([
      'web_form',
      'unknown',
    ]);
  });

  it('is not a stored source: the plain parser still drops it', () => {
    expect(parseLeadSources('ad,unknown')).toEqual(['ad']);
  });

  it('builds the PostgREST parts for known only, unknown only, both, none', () => {
    expect(sourceFilterParts(['web_form', 'ad'])).toEqual({
      in: ['ad', 'web_form'],
      or: null,
    });
    expect(sourceFilterParts(['unknown'])).toEqual({
      in: null,
      or: 'lead_source.is.null',
    });
    expect(sourceFilterParts(['ad', 'unknown'])).toEqual({
      in: null,
      or: 'lead_source.in.(ad),lead_source.is.null',
    });
    expect(sourceFilterParts([])).toEqual({ in: null, or: null });
    expect(sourceFilterParts(['ghost', 'a),b.eq.1'])).toEqual({
      in: null,
      or: null,
    });
  });
});
