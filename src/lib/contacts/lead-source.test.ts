import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isLeadSource,
  leadSourceFilter,
  leadSourceOf,
  LEAD_SOURCE_FILTER_VALUES,
  LEAD_SOURCES,
  parseLeadSources,
  UNKNOWN_LEAD_SOURCE,
} from './lead-source';

describe('the Unknown filter value (migration 331)', () => {
  it('parses, after the named sources', () => {
    expect(parseLeadSources('unknown,ad')).toEqual(['ad', UNKNOWN_LEAD_SOURCE]);
    expect(parseLeadSources([' unknown '])).toEqual(['unknown']);
    expect(LEAD_SOURCE_FILTER_VALUES.at(-1)).toBe('unknown');
  });
  it('is never a stored source', () => {
    expect(isLeadSource(UNKNOWN_LEAD_SOURCE)).toBe(false);
    expect(leadSourceOf({ lead_source: 'unknown' })).toBeNull();
  });
  it('matches no lead source recorded, alone or with named ones', () => {
    expect(leadSourceFilter(['unknown'])).toBe('lead_source.is.null');
    expect(leadSourceFilter(['unknown', 'web_form', 'ad'])).toBe(
      'lead_source.in.(ad,web_form),lead_source.is.null'
    );
  });
  it('is the literal 331 matches in both RPCs, and 249 never stores it', () => {
    const read = (file: string) =>
      readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8');
    const sql = read('331_contacts_unknown_source.sql');
    expect(sql).toContain(
      `OR (c.lead_source IS NULL AND '${UNKNOWN_LEAD_SOURCE}' = ANY (v_sources))`
    );
    expect(sql).toContain(
      `OR (c.lead_source IS NULL AND ''${UNKNOWN_LEAD_SOURCE}'' = ANY (@s))`
    );
    expect(read('249_lead_source_web_form.sql')).not.toContain(
      `'${UNKNOWN_LEAD_SOURCE}'`
    );
  });
});

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
