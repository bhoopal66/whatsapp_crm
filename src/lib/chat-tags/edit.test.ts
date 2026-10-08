import { describe, it, expect } from 'vitest';

import {
  CHAT_TAG_COLORS,
  CHAT_TAG_NAME_MAX,
  CHAT_TAG_SUB_TITLE_MAX,
  moveChatTag,
  nextChatTagPosition,
  normalizeChatTagName,
  normalizeSubTagTitle,
  validateChatTagName,
  type ChatTagColorName,
} from './edit';

describe('limits and palette', () => {
  it('pins the limits', () => {
    expect(CHAT_TAG_NAME_MAX).toBe(40);
    expect(CHAT_TAG_SUB_TITLE_MAX).toBe(30);
  });

  it('offers ten distinct lowercase #rrggbb colours', () => {
    expect(CHAT_TAG_COLORS).toHaveLength(10);
    for (const c of CHAT_TAG_COLORS) {
      expect(c.value).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(new Set(CHAT_TAG_COLORS.map((c) => c.value)).size).toBe(10);
    const names: ChatTagColorName[] = CHAT_TAG_COLORS.map((c) => c.name);
    expect(names).toEqual([
      'red',
      'orange',
      'amber',
      'emerald',
      'teal',
      'sky',
      'blue',
      'violet',
      'pink',
      'slate',
    ]);
    expect(CHAT_TAG_COLORS.find((c) => c.name === 'slate')?.value).toBe(
      '#64748b'
    );
  });
});

describe('normalizeChatTagName', () => {
  it('trims and collapses whitespace runs', () => {
    expect(normalizeChatTagName('  New \t\n customer  ')).toBe('New customer');
    expect(normalizeChatTagName('   ')).toBe('');
  });
});

describe('validateChatTagName', () => {
  const siblings = [
    { id: 'a', name: 'New customer' },
    { id: 'b', name: 'Interested  customer' },
  ];

  it('rejects a blank name', () => {
    expect(validateChatTagName('', siblings)).toBe('empty');
    expect(validateChatTagName(' \t ', siblings)).toBe('empty');
  });

  it('rejects a name over the limit after normalizing', () => {
    expect(validateChatTagName('x'.repeat(40), [])).toBeNull();
    expect(validateChatTagName('x'.repeat(41), [])).toBe('too_long');
    expect(validateChatTagName(`  ${'x'.repeat(40)}  `, [])).toBeNull();
  });

  it('counts characters, not UTF-16 units', () => {
    expect(validateChatTagName('😀'.repeat(40), [])).toBeNull();
    expect(validateChatTagName('😀'.repeat(41), [])).toBe('too_long');
  });

  it('rejects a case or spacing variant of a sibling', () => {
    expect(validateChatTagName('new CUSTOMER', siblings)).toBe('duplicate');
    expect(validateChatTagName('  new   customer ', siblings)).toBe(
      'duplicate'
    );
    expect(validateChatTagName('interested customer', siblings)).toBe(
      'duplicate'
    );
  });

  it('lets a tag keep or recase its own name', () => {
    expect(validateChatTagName('NEW customer', siblings, 'a')).toBeNull();
    expect(validateChatTagName('new customer', siblings, 'b')).toBe(
      'duplicate'
    );
  });

  it('accepts a fresh name', () => {
    expect(validateChatTagName('VIP', siblings)).toBeNull();
  });
});

describe('normalizeSubTagTitle', () => {
  it('normalizes, and blank means none', () => {
    expect(normalizeSubTagTitle('  Bank   name ')).toBe('Bank name');
    expect(normalizeSubTagTitle('   ')).toBeNull();
    expect(normalizeSubTagTitle('')).toBeNull();
  });
});

describe('nextChatTagPosition', () => {
  it('is 0 for the first tag', () => {
    expect(nextChatTagPosition([])).toBe(0);
  });

  it('is one past the highest, gaps and order notwithstanding', () => {
    expect(
      nextChatTagPosition([{ position: 7 }, { position: 2 }, { position: 7 }])
    ).toBe(8);
  });
});

describe('moveChatTag', () => {
  const tidy = [
    { id: 'a', position: 0 },
    { id: 'b', position: 1 },
    { id: 'c', position: 2 },
  ];

  it('swaps a tag with its neighbour', () => {
    expect(moveChatTag(tidy, 'b', 'up')).toEqual([
      { id: 'b', position: 0 },
      { id: 'a', position: 1 },
    ]);
    expect(moveChatTag(tidy, 'b', 'down')).toEqual([
      { id: 'c', position: 1 },
      { id: 'b', position: 2 },
    ]);
  });

  it('does nothing at either end or for an unknown id', () => {
    expect(moveChatTag(tidy, 'a', 'up')).toEqual([]);
    expect(moveChatTag(tidy, 'c', 'down')).toEqual([]);
    expect(moveChatTag(tidy, 'zz', 'up')).toEqual([]);
    expect(moveChatTag([], 'a', 'down')).toEqual([]);
  });

  it('renumbers colliding positions so the move takes effect', () => {
    const colliding = [
      { id: 'a', position: 0 },
      { id: 'b', position: 0 },
      { id: 'c', position: 0 },
    ];
    expect(moveChatTag(colliding, 'c', 'up')).toEqual([
      { id: 'c', position: 1 },
      { id: 'b', position: 2 },
    ]);
  });

  it('closes gaps, writing only rows that change', () => {
    const gappy = [
      { id: 'a', position: 0 },
      { id: 'b', position: 5 },
      { id: 'c', position: 9 },
      { id: 'd', position: 3 },
    ];
    // d already sits at 3, so it is not written.
    expect(moveChatTag(gappy, 'a', 'down')).toEqual([
      { id: 'b', position: 0 },
      { id: 'a', position: 1 },
      { id: 'c', position: 2 },
    ]);
  });
});
