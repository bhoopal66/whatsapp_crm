import { describe, expect, it } from 'vitest';
import {
  canTranslateDraft,
  landTranslation,
  TRANSLATE_MAX_CHARS,
  undoAvailable,
} from './draft';

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

describe('landTranslation', () => {
  const base = {
    requested: 'Your application was approved',
    requestedChat: 'chat-a',
    currentText: 'Your application was approved',
    currentChat: 'chat-a',
  };

  it('applies when the box and the chat are as they were', () => {
    expect(landTranslation(base)).toBe('apply');
  });

  it('keeps what the agent typed since the request', () => {
    expect(
      landTranslation({
        ...base,
        currentText: 'Your application was approved!',
      })
    ).toBe('changed');
    expect(landTranslation({ ...base, currentText: '' })).toBe('changed');
  });

  it('drops the answer once the composer is on another chat', () => {
    expect(landTranslation({ ...base, currentChat: 'chat-b' })).toBe('moved');
    expect(landTranslation({ ...base, currentChat: null })).toBe('moved');
  });

  it('checks the chat before the text', () => {
    expect(
      landTranslation({ ...base, currentChat: 'chat-b', currentText: 'other' })
    ).toBe('moved');
  });
});
