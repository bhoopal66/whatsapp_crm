import { describe, expect, it } from 'vitest';
import {
  arabicShare,
  canTranslateMessage,
  countLetters,
  hasArabicText,
  isMostlyArabic,
} from './detect';

describe('countLetters', () => {
  it('counts Arabic-script letters among all letters', () => {
    expect(countLetters('مرحبا')).toEqual({ arabic: 5, letters: 5 });
    expect(countLetters('hi مرحبا')).toEqual({ arabic: 5, letters: 7 });
  });

  it('ignores digits, punctuation, emoji and diacritics', () => {
    expect(countLetters('١٢٣ 123 ؟ ! 👍')).toEqual({ arabic: 0, letters: 0 });
    // "مَرْحَبًا" carries harakat: still five letters.
    expect(countLetters('مَرْحَبًا')).toEqual({ arabic: 5, letters: 5 });
  });
});

describe('arabicShare', () => {
  it('is 0 for text with no letters', () => {
    expect(arabicShare('')).toBe(0);
    expect(arabicShare('12345')).toBe(0);
  });

  it('is the Arabic share of letters', () => {
    expect(arabicShare('ab مر')).toBe(0.5);
  });
});

describe('hasArabicText', () => {
  it('offers Arabic messages, mixed ones included', () => {
    expect(hasArabicText('السلام عليكم، أبي قرض شخصي')).toBe(true);
    expect(hasArabicText('ابي personal loan بسرعة')).toBe(true);
  });

  it('does not offer English, empty or stray-letter text', () => {
    expect(hasArabicText('Hello, I need a loan')).toBe(false);
    expect(hasArabicText('')).toBe(false);
    expect(hasArabicText(null)).toBe(false);
    expect(hasArabicText(undefined)).toBe(false);
    // One Arabic letter is below MIN_ARABIC_LETTERS.
    expect(hasArabicText('ok و')).toBe(false);
    // Arabic-Indic digits are not letters.
    expect(hasArabicText('٠٥٠١٢٣٤٥٦٧')).toBe(false);
  });

  it('needs Arabic to be at least 30% of the letters', () => {
    // 2 Arabic of 24 letters is about 8%.
    expect(hasArabicText('Thanks a lot for the update مع')).toBe(false);
  });
});

describe('isMostlyArabic', () => {
  it('is true from 60% Arabic letters', () => {
    expect(isMostlyArabic('شكرا جزيلا')).toBe(true);
    expect(isMostlyArabic('شكرا ok')).toBe(true);
    expect(isMostlyArabic('Thank you شكرا')).toBe(false);
    expect(isMostlyArabic('')).toBe(false);
  });
});

describe('canTranslateMessage', () => {
  const arabic = 'أريد أن أعرف حالة طلبي';

  it('offers a customer text or photo/video caption in Arabic', () => {
    for (const content_type of ['text', 'image', 'video'] as const) {
      expect(
        canTranslateMessage({
          sender_type: 'customer',
          content_type,
          content_text: arabic,
        })
      ).toBe(true);
    }
  });

  it('never offers our own messages', () => {
    for (const sender_type of ['agent', 'bot'] as const) {
      expect(
        canTranslateMessage({
          sender_type,
          content_type: 'text',
          content_text: arabic,
        })
      ).toBe(false);
    }
  });

  it('skips a message longer than the route accepts', () => {
    const atLimit = 'م'.repeat(4096);
    expect(
      canTranslateMessage({
        sender_type: 'customer',
        content_type: 'text',
        content_text: atLimit,
      })
    ).toBe(true);
    expect(
      canTranslateMessage({
        sender_type: 'customer',
        content_type: 'text',
        content_text: atLimit + 'م',
      })
    ).toBe(false);
  });

  it('skips documents, other kinds and empty text', () => {
    expect(
      canTranslateMessage({
        sender_type: 'customer',
        content_type: 'document',
        content_text: 'كشف حساب.pdf',
      })
    ).toBe(false);
    expect(
      canTranslateMessage({
        sender_type: 'customer',
        content_type: 'interactive',
        content_text: arabic,
      })
    ).toBe(false);
    expect(
      canTranslateMessage({ sender_type: 'customer', content_type: 'text' })
    ).toBe(false);
  });
});
