import { describe, expect, it } from 'vitest';
import {
  autoTagLabel,
  autoTagPercent,
  isRenderedEventKind,
  RENDERED_EVENT_KINDS,
} from './tag-note';

describe('autoTagLabel', () => {
  it('joins main and sub-tag names like the chat header pill', () => {
    expect(autoTagLabel('Interested', 'ADCB')).toBe('Interested · ADCB');
  });
  it('a main tag alone, or a blank sub-tag, is the main name', () => {
    expect(autoTagLabel('Interested', null)).toBe('Interested');
    expect(autoTagLabel(' Interested ', '  ')).toBe('Interested');
  });
  it('no main name, no label', () => {
    expect(autoTagLabel(null, 'ADCB')).toBeNull();
    expect(autoTagLabel(' ', null)).toBeNull();
    expect(autoTagLabel(undefined, undefined)).toBeNull();
  });
});

describe('autoTagPercent', () => {
  it('rounds the probability to a whole percent', () => {
    expect(autoTagPercent({ p: 0.92 })).toBe(92);
    expect(autoTagPercent({ p: 0.856 })).toBe(86);
    expect(autoTagPercent({ p: 1 })).toBe(100);
    expect(autoTagPercent({ p: 0 })).toBe(0);
  });
  it('null when details or p is missing or not a probability', () => {
    for (const d of [
      null,
      undefined,
      'x',
      {},
      { p: '0.9' },
      { p: NaN },
      { p: 1.2 },
      { p: -0.1 },
    ])
      expect(autoTagPercent(d)).toBeNull();
  });
});

describe('isRenderedEventKind', () => {
  it('only the kinds the timeline knows how to draw', () => {
    expect(RENDERED_EVENT_KINDS).toEqual(['channel_switched', 'chat_tag_auto']);
    expect(isRenderedEventKind('channel_switched')).toBe(true);
    expect(isRenderedEventKind('chat_tag_auto')).toBe(true);
    expect(isRenderedEventKind('member_added')).toBe(false);
    expect(isRenderedEventKind(undefined)).toBe(false);
  });
});
