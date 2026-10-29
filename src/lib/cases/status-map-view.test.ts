import { describe, expect, it } from 'vitest';

import {
  chipFor,
  mergeSuggestions,
  parseApplied,
  parseMapping,
  parseStatusMap,
  parseSuggestions,
  percent,
  sortUnmapped,
  statusMapError,
  withSaved,
} from './status-map-view';

const body = {
  stages: ['Submitted', 'Under review', 'Query raised'],
  mapped: [
    {
      status_key: 'ZED',
      status_label: 'Zed',
      stage: 'Submitted',
      source: 'admin',
      suggested_p: null,
      open_cases: 1,
      stage_known: true,
    },
    {
      status_key: 'BANK REVIEW',
      status_label: 'Bank Review',
      stage: 'Under review',
      source: 'suggestion',
      suggested_p: 0.87,
      open_cases: 4,
      stage_known: false,
    },
  ],
  unmapped: [
    { status_key: 'B', sample_label: 'Beta', open_cases: 2 },
    { status_key: 'A', sample_label: 'Alpha', open_cases: 2 },
    { status_key: 'C', sample_label: 'Gamma', open_cases: 9 },
    { nope: true },
  ],
  suggestions: {},
  available: true,
};

describe('parseStatusMap', () => {
  it('orders unmapped by open cases then label, mapped by label', () => {
    const v = parseStatusMap(body)!;
    expect(v.unmapped.map((u) => u.status_key)).toEqual(['C', 'A', 'B']);
    expect(v.mapped.map((m) => m.status_key)).toEqual(['BANK REVIEW', 'ZED']);
    expect(v.mapped[0]).toMatchObject({
      source: 'suggestion',
      suggested_p: 0.87,
      stage_known: false,
    });
    expect(v.available).toBe(true);
  });

  it('refuses a body that is not an overview', () => {
    expect(parseStatusMap(null)).toBeNull();
    expect(parseStatusMap({ stages: [] })).toBeNull();
    expect(parseStatusMap({ error: 'x' })).toBeNull();
  });

  it('reads available only when it is true', () => {
    expect(parseStatusMap({ ...body, available: 'yes' })!.available).toBe(
      false
    );
  });
});

describe('sortUnmapped', () => {
  it('falls back to the key when there is no sample label', () => {
    const rows = sortUnmapped([
      { status_key: 'Y', sample_label: '', open_cases: 0 },
      { status_key: 'X', sample_label: '', open_cases: 0 },
    ]);
    expect(rows.map((r) => r.status_key)).toEqual(['X', 'Y']);
  });
});

describe('suggestions', () => {
  it('keeps listed stages and null, drops the rest', () => {
    const s = parseSuggestions(
      {
        suggestions: {
          A: { stage: 'Under review', p: 0.87, runnerUp: null },
          B: { stage: null, p: 0.6, runnerUp: null },
          C: { stage: 'Gone stage', p: 0.9 },
          D: { stage: 'Submitted', p: 1.5 },
          E: 'junk',
        },
      },
      body.stages
    );
    expect(s).toEqual({
      A: { stage: 'Under review', p: 0.87 },
      B: { stage: null, p: 0.6 },
    });
  });

  it('answers {} when the body has none', () => {
    expect(parseSuggestions({}, body.stages)).toEqual({});
  });

  it('lets later suggestions win', () => {
    expect(
      mergeSuggestions(
        { A: { stage: 'Submitted', p: 0.5 }, B: { stage: null, p: 0.4 } },
        { A: { stage: 'Under review', p: 0.9 } }
      )
    ).toEqual({
      A: { stage: 'Under review', p: 0.9 },
      B: { stage: null, p: 0.4 },
    });
  });
});

describe('chip and percent', () => {
  it('rounds and clamps', () => {
    expect(percent(0.874)).toBe(87);
    expect(percent(0.876)).toBe(88);
    expect(percent(2)).toBe(100);
    expect(percent(-1)).toBe(0);
    expect(percent(Number.NaN)).toBe(0);
  });

  it('says a stage or no stage change', () => {
    expect(chipFor({ stage: 'Under review', p: 0.87 })).toEqual({
      kind: 'stage',
      stage: 'Under review',
      pct: 87,
    });
    expect(chipFor({ stage: null, p: 0.6 })).toEqual({ kind: 'none', pct: 60 });
  });
});

describe('withSaved', () => {
  it('moves the row to mapped with its open cases', () => {
    const v = parseStatusMap(body)!;
    const next = withSaved(v, {
      status_key: 'C',
      status_label: 'Gamma',
      stage: 'Query raised',
      source: 'suggestion',
      suggested_p: 0.7,
    });
    expect(next.unmapped.map((u) => u.status_key)).toEqual(['A', 'B']);
    expect(next.mapped.find((m) => m.status_key === 'C')).toEqual({
      status_key: 'C',
      status_label: 'Gamma',
      stage: 'Query raised',
      source: 'suggestion',
      suggested_p: 0.7,
      open_cases: 9,
      stage_known: true,
    });
  });

  it('replaces an older mapping of the same key', () => {
    const v = parseStatusMap(body)!;
    const next = withSaved(v, {
      status_key: 'ZED',
      status_label: 'Zed',
      stage: 'Query raised',
      source: 'admin',
      suggested_p: null,
    });
    const zed = next.mapped.filter((m) => m.status_key === 'ZED');
    expect(zed).toHaveLength(1);
    expect(zed[0]).toMatchObject({ stage: 'Query raised', open_cases: 1 });
  });
});

describe('answers', () => {
  it('parses a mapping and apply counts', () => {
    expect(
      parseMapping({
        mapping: {
          status_key: 'A',
          status_label: 'Alpha',
          stage: 'Submitted',
          source: 'admin',
          suggested_p: null,
        },
      })
    ).toMatchObject({ status_key: 'A', stage: 'Submitted', source: 'admin' });
    expect(parseMapping({ mapping: { status_key: 'A' } })).toBeNull();
    expect(parseApplied({ moved: 3, unchanged: 1 })).toEqual({
      moved: 3,
      unchanged: 1,
    });
    expect(parseApplied({})).toBeNull();
  });

  it('names known refusals and passes others through', () => {
    expect(statusMapError({ code: 'STATUS_FINAL', error: 'x' }, 422)).toEqual({
      key: 'statusFinal',
    });
    expect(statusMapError({ code: 'STAGE_NOT_CONFIGURED' }, 422)).toEqual({
      key: 'stageNotConfigured',
    });
    expect(statusMapError({ code: 'OTHER', error: 'Nope' }, 422)).toEqual({
      text: 'Nope',
    });
    expect(statusMapError(null, 0)).toEqual({ text: 'HTTP 0' });
  });
});
