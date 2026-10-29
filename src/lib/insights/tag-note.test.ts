import { describe, expect, it } from 'vitest';
import {
  autoTagLabel,
  autoTagPercent,
  isRenderedEventKind,
  RENDERED_EVENT_KINDS,
  pinClearedHow,
  pinNoteReason,
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
    expect(RENDERED_EVENT_KINDS).toEqual([
      'channel_switched',
      'chat_tag_auto',
      'insight_attention_set',
      'insight_attention_cleared',
    ]);
    expect(isRenderedEventKind('channel_switched')).toBe(true);
    expect(isRenderedEventKind('chat_tag_auto')).toBe(true);
    expect(isRenderedEventKind('member_added')).toBe(false);
    expect(isRenderedEventKind(undefined)).toBe(false);
  });
});

describe('pin notes', () => {
  it('draws both pin kinds', () => {
    expect(isRenderedEventKind('insight_attention_set')).toBe(true);
    expect(isRenderedEventKind('insight_attention_cleared')).toBe(true);
  });
  it('reads the reason only when it is one we word', () => {
    expect(pinNoteReason({ reason: 'wants_person' })).toBe('wants_person');
    expect(pinNoteReason({ reason: 'ai_handoff' })).toBeNull();
    expect(pinNoteReason(null)).toBeNull();
    expect(pinNoteReason({ reason: 3 })).toBeNull();
  });
  it('reads how a pin was lifted, defaulting to handled', () => {
    expect(pinClearedHow({ how: 'reply' })).toBe('reply');
    expect(pinClearedHow({ how: 'closed' })).toBe('closed');
    expect(pinClearedHow({ how: 'handled' })).toBe('handled');
    expect(pinClearedHow({ how: 'x' })).toBe('handled');
    expect(pinClearedHow(undefined)).toBe('handled');
  });
});
