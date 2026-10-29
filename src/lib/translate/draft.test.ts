import { describe, expect, it } from 'vitest';
import { canTranslateDraft, TRANSLATE_MAX_CHARS, undoAvailable } from './draft';

describe('canTranslateDraft', () => {
  it('offers English and mixed drafts', () => {
    expect(canTranslateDraft('Your application was approved')).toBe(true);
    expect(canTranslateDraft('Thank you شكرا')).toBe(true);
    expect(canTranslateDraft('12,500 AED 👍')).toBe(true);
  });

  it('hides for empty, letterless or already-Arabic drafts', () => {
    expect(canTranslateDraft('')).toBe(false);
    expect(canTranslateDraft('   ')).toBe(false);
    expect(canTranslateDraft('12,500 👍')).toBe(false);
    expect(canTranslateDraft('تمت الموافقة على طلبك')).toBe(false);
  });

  it('hides for text longer than WhatsApp sends', () => {
    expect(canTranslateDraft('a'.repeat(TRANSLATE_MAX_CHARS))).toBe(true);
    expect(canTranslateDraft('a'.repeat(TRANSLATE_MAX_CHARS + 1))).toBe(false);
  });
});

describe('undoAvailable', () => {
  const state = { original: 'Hello', translated: 'مرحبا' };

  it('is offered while the box holds exactly the translation', () => {
    expect(undoAvailable(state, 'مرحبا')).toBe(true);
  });

  it('ends with any edit, and without a translation', () => {
    expect(undoAvailable(state, 'مرحبا!')).toBe(false);
    expect(undoAvailable(state, '')).toBe(false);
    expect(undoAvailable(null, 'مرحبا')).toBe(false);
  });
});
