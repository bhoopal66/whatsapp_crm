import { describe, it, expect } from 'vitest';

import {
  chatTagChipStyle,
  chatTagColor,
  chatTagMainStyle,
  chatTagSubStyle,
  chatTagTextColor,
} from './style';

describe('chatTagColor', () => {
  it('keeps a valid #rrggbb colour, lowercased', () => {
    expect(chatTagColor('#ef4444')).toBe('#ef4444');
    expect(chatTagColor('#EF4444')).toBe('#ef4444');
  });

  it('falls back to slate for anything else', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'red',
      '#fff',
      'ef4444',
      '#ef44445',
      '#gg4444',
      ' #ef4444',
      'url(x)',
    ]) {
      expect(chatTagColor(bad)).toBe('#64748b');
    }
  });
});

describe('chatTagChipStyle', () => {
  it('tints fill and border from the colour', () => {
    expect(chatTagChipStyle('#3b82f6')).toEqual({
      backgroundColor: 'rgba(59, 130, 246, 0.14)',
      borderColor: 'rgba(59, 130, 246, 0.45)',
    });
  });

  it('uses the fallback for an invalid colour', () => {
    expect(chatTagChipStyle('not-a-colour')).toEqual({
      backgroundColor: 'rgba(100, 116, 139, 0.14)',
      borderColor: 'rgba(100, 116, 139, 0.45)',
    });
  });
});

describe('chatTagTextColor', () => {
  it('mixes the tag colour with the theme text colour', () => {
    expect(chatTagTextColor('#3B82F6')).toBe(
      'color-mix(in oklab, #3b82f6 55%, var(--wa-text))'
    );
  });

  it('never lets an invalid colour into the CSS', () => {
    expect(chatTagTextColor('red; background: url(x)')).toBe(
      'color-mix(in oklab, #64748b 55%, var(--wa-text))'
    );
  });
});

describe('chatTagMainStyle', () => {
  it('is the chip tint plus the tinted text', () => {
    expect(chatTagMainStyle('#3b82f6')).toEqual({
      backgroundColor: 'rgba(59, 130, 246, 0.14)',
      borderColor: 'rgba(59, 130, 246, 0.45)',
      color: 'color-mix(in oklab, #3b82f6 55%, var(--wa-text))',
    });
  });
});

describe('chatTagSubStyle', () => {
  it('fills faintly in the sub-tag colour, bordered in the main tag colour', () => {
    expect(chatTagSubStyle('#f59e0b', '#3b82f6')).toEqual({
      backgroundColor: 'rgba(59, 130, 246, 0.06)',
      borderColor: 'rgba(245, 158, 11, 0.45)',
      borderLeftColor: 'rgba(245, 158, 11, 0.3)',
    });
  });

  it('is fainter than the main half', () => {
    const main = chatTagMainStyle('#f59e0b');
    const sub = chatTagSubStyle('#f59e0b', '#f59e0b');
    expect(main.backgroundColor).toBe('rgba(245, 158, 11, 0.14)');
    expect(sub.backgroundColor).toBe('rgba(245, 158, 11, 0.06)');
  });
});
