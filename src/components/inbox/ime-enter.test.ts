import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { shouldSendOnKey } from '@/lib/groups/group-page';
import { isImeKey } from '@/lib/keyboard/ime';

describe('isImeKey', () => {
  it('is true while composing, and for the keyCode Safari sends', () => {
    expect(isImeKey({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeKey({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it('is false for a plain Enter', () => {
    expect(isImeKey({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeKey({})).toBe(false);
  });
});

describe('the group composer', () => {
  it("does not send on Safari's Enter that ends a composition", () => {
    expect(
      shouldSendOnKey({ key: 'Enter', shiftKey: false, keyCode: 229 })
    ).toBe(false);
    expect(
      shouldSendOnKey({ key: 'Enter', shiftKey: false, keyCode: 13 })
    ).toBe(true);
  });
});

// No DOM here, so the handlers are read: each one that acts on Enter
// leaves a composing key alone first.
describe('the chat and note boxes', () => {
  it.each([
    ['message-composer.tsx', 2], // the message, the caption
    ['note-composer.tsx', 1],
    ['thread-note.tsx', 1],
  ])('%s leaves a composing key alone', (file, handlers) => {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const guards = src.match(
      /=> \{\n\s*if \(isImeKey\(e\.nativeEvent\)\) return;\n/g
    );
    expect(guards).toHaveLength(handlers);
    expect(src.match(/e\.key === 'Enter' && !e\.shiftKey/g)).toHaveLength(
      handlers
    );
  });
});
