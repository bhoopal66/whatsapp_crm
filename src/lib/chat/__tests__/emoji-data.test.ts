import { describe, expect, it } from 'vitest';

import {
  EMOJI,
  EMOJI_CATEGORIES,
  emojiIn,
  gridMove,
  parseRecents,
  pushRecent,
  searchEmoji,
} from '../emoji-data';

describe('emoji data', () => {
  it('has every category filled and no duplicates', () => {
    for (const c of EMOJI_CATEGORIES)
      expect(emojiIn(c).length).toBeGreaterThan(0);
    expect(new Set(EMOJI.map((e) => e.emoji)).size).toBe(EMOJI.length);
    expect(EMOJI.length).toBeGreaterThanOrEqual(300);
  });

  it('keeps every emoji within what a reaction accepts (1–32 chars)', () => {
    for (const e of EMOJI) {
      expect(e.emoji.length).toBeGreaterThanOrEqual(1);
      expect(e.emoji.length).toBeLessThanOrEqual(32);
      expect(e.name).toBe(e.name.toLowerCase());
    }
  });

  it('carries the quick reactions and the Gulf flags', () => {
    const all = new Set(EMOJI.map((e) => e.emoji));
    for (const e of ['👍', '✅', '👀', '🙏', '❤️', '😂'])
      expect(all).toContain(e);
    const flags = emojiIn('flags').map((x) => x.emoji);
    for (const e of [
      '🇦🇪',
      '🇸🇦',
      '🇰🇼',
      '🇶🇦',
      '🇧🇭',
      '🇴🇲',
      '🇮🇳',
      '🇵🇰',
      '🇵🇭',
      '🇬🇧',
      '🇺🇸',
    ])
      expect(flags).toContain(e);
  });
});

describe('searchEmoji', () => {
  it('matches nothing for a blank query', () => {
    expect(searchEmoji('')).toEqual([]);
    expect(searchEmoji('   ')).toEqual([]);
  });

  it('is case-insensitive and finds keywords', () => {
    expect(searchEmoji('UAE')[0].emoji).toBe('🇦🇪');
    expect(searchEmoji('ksa')[0].emoji).toBe('🇸🇦');
    expect(searchEmoji('Thumbs')[0].emoji).toBe('👍');
  });

  it('ranks a name prefix before a word prefix before a substring', () => {
    const r = searchEmoji('tea');
    const rank = (n: string, kw: readonly string[]) =>
      n.startsWith('tea')
        ? 0
        : [...n.split(' '), ...kw].some((w) => w.startsWith('tea'))
          ? 1
          : 2;
    const ranks = r.map((e) => rank(e.name, e.keywords));
    expect(ranks[0]).toBe(0);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks)).toEqual(new Set([0, 1, 2]));
  });

  it('matches a substring when no word starts with it', () => {
    expect(searchEmoji('mbs').map((e) => e.emoji)).toContain('👍');
    expect(searchEmoji('zzzz-nothing')).toEqual([]);
  });
});

describe('recents', () => {
  it('puts the newest first without duplicates and caps the list', () => {
    expect(pushRecent(['👍', '😂'], '😂')).toEqual(['😂', '👍']);
    expect(pushRecent([], '👍')).toEqual(['👍']);
    const many = Array.from({ length: 30 }, (_, i) => String(i));
    expect(pushRecent(many, 'x')).toHaveLength(24);
    expect(pushRecent(many, 'x', 3)).toEqual(['x', '0', '1']);
  });

  it('parses stored recents defensively', () => {
    expect(parseRecents(null)).toEqual([]);
    expect(parseRecents('not json')).toEqual([]);
    expect(parseRecents('{"a":1}')).toEqual([]);
    const raw = JSON.stringify(['👍', 3, '', '👍', 'x'.repeat(33), '✅']);
    expect(parseRecents(raw)).toEqual(['👍', '✅']);
  });
});

describe('gridMove', () => {
  // 10 cells, 4 wide: rows 0-3, 4-7, 8-9.
  it('steps left and right and stops at the ends', () => {
    expect(gridMove(0, 'ArrowLeft', 10, 4)).toBe(0);
    expect(gridMove(3, 'ArrowRight', 10, 4)).toBe(4);
    expect(gridMove(9, 'ArrowRight', 10, 4)).toBe(9);
  });

  it('jumps rows, clamping into a short last row', () => {
    expect(gridMove(5, 'ArrowUp', 10, 4)).toBe(1);
    expect(gridMove(1, 'ArrowUp', 10, 4)).toBe(1);
    expect(gridMove(1, 'ArrowDown', 10, 4)).toBe(5);
    expect(gridMove(7, 'ArrowDown', 10, 4)).toBe(9);
    expect(gridMove(9, 'ArrowDown', 10, 4)).toBe(9);
  });

  it('has no cell in an empty grid', () => {
    expect(gridMove(0, 'ArrowDown', 0, 4)).toBe(-1);
  });
});
