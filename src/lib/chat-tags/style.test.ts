import { describe, it, expect } from 'vitest';

import { chatTagChipStyle, chatTagColor } from './style';

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
