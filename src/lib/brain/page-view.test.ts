import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  brainPageState,
  builtAgo,
  parseBrainPage,
  parseRebuildResult,
  shortCitationId,
} from './page-view';

const PAGE = {
  kind: 'case',
  key: '11111111-2222-3333-4444-555555555555',
  summary: 'Line one\nLine two',
  aiGenerated: true,
  version: 3,
  builtAt: '2026-11-12T10:00:00.000Z',
  citations: [
    { kind: 'note', id: 'abcdef0123456789' },
    { kind: 'timeline', id: '99999999-0000' },
  ],
};

describe('parseBrainPage', () => {
  it('keeps the summary, version, build time and citations', () => {
    expect(parseBrainPage(PAGE)).toEqual({
      summary: 'Line one\nLine two',
      version: 3,
      builtAt: '2026-11-12T10:00:00.000Z',
      citations: [
        { kind: 'note', id: 'abcdef0123456789' },
        { kind: 'timeline', id: '99999999-0000' },
      ],
    });
  });

  it("drops the summariser's own header line (the tab shows it)", () => {
    const v = parseBrainPage({
      ...PAGE,
      summary: 'AI-generated summary - verify against the case\nLine one',
    });
    expect(v?.summary).toBe('Line one');
  });

  it('accepts a null build time and no citations', () => {
    expect(parseBrainPage({ ...PAGE, builtAt: null, citations: [] })).toEqual({
      summary: PAGE.summary,
      version: 3,
      builtAt: null,
      citations: [],
    });
  });

  it('rejects a malformed body', () => {
    expect(parseBrainPage(null)).toBeNull();
    expect(parseBrainPage([])).toBeNull();
    expect(parseBrainPage({ ...PAGE, summary: 1 })).toBeNull();
    expect(parseBrainPage({ ...PAGE, version: -1 })).toBeNull();
    expect(parseBrainPage({ ...PAGE, version: 1.5 })).toBeNull();
    expect(parseBrainPage({ ...PAGE, builtAt: 5 })).toBeNull();
    expect(parseBrainPage({ ...PAGE, citations: 'x' })).toBeNull();
    expect(parseBrainPage({ ...PAGE, citations: [{ kind: 'note' }] })).toBe(
      null
    );
  });
});

describe('brainPageState', () => {
  it('shows the page on a well-formed 200', () => {
    const s = brainPageState(200, PAGE);
    expect(s.kind).toBe('page');
  });

  it('reads 404 as "no summary yet", not an error', () => {
    expect(brainPageState(404, { error: 'Not found' })).toEqual({
      kind: 'none',
    });
  });

  it('reads 403 brain_disabled as the switch being off', () => {
    expect(brainPageState(403, { error: 'brain_disabled' })).toEqual({
      kind: 'off',
    });
  });

  it('treats any other answer, or a bad body, as an error', () => {
    expect(brainPageState(403, { error: 'Forbidden' }).kind).toBe('error');
    expect(brainPageState(500, { error: 'x' }).kind).toBe('error');
    expect(brainPageState(200, { summary: 'x' }).kind).toBe('error');
  });
});

describe('parseRebuildResult', () => {
  it('reads the three counts', () => {
    expect(parseRebuildResult({ rebuilt: 4, failed: 1, remaining: 7 })).toEqual(
      { rebuilt: 4, failed: 1, remaining: 7 }
    );
  });

  it('rejects a malformed body', () => {
    expect(parseRebuildResult(null)).toBeNull();
    expect(parseRebuildResult({ rebuilt: 1, failed: 0 })).toBeNull();
    expect(
      parseRebuildResult({ rebuilt: '1', failed: 0, remaining: 0 })
    ).toBeNull();
  });
});

describe('labels', () => {
  it('shortens a citation id to 8 characters', () => {
    expect(shortCitationId('abcdef0123456789')).toBe('abcdef01');
    expect(shortCitationId('abc')).toBe('abc');
  });

  it('measures how long ago a page was built', () => {
    const now = Date.parse('2026-11-12T12:00:00.000Z');
    expect(builtAgo(null, now)).toBeNull();
    expect(builtAgo('not a date', now)).toBeNull();
    expect(builtAgo('2026-11-12T11:59:30.000Z', now)).toEqual({ unit: 'now' });
    // A server clock a little ahead never reads as the future.
    expect(builtAgo('2026-11-12T12:01:00.000Z', now)).toEqual({ unit: 'now' });
    expect(builtAgo('2026-11-12T11:15:00.000Z', now)).toEqual({
      unit: 'minute',
      value: 45,
    });
    expect(builtAgo('2026-11-12T09:00:00.000Z', now)).toEqual({
      unit: 'hour',
      value: 3,
    });
    expect(builtAgo('2026-11-09T11:00:00.000Z', now)).toEqual({
      unit: 'day',
      value: 3,
    });
  });
});

describe('client safety', () => {
  it('imports nothing at runtime (the tab is a client component)', () => {
    const src = readFileSync(join(__dirname, 'page-view.ts'), 'utf8');
    expect(src).not.toMatch(/^import (?!type )/m);
  });
});
