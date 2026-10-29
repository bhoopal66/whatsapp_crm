import type { ContentType, SenderType } from '@/types';

// Letters only: digits (including Arabic-Indic ١٢٣), punctuation such as
// "؟", emoji and diacritics never make a message "Arabic" on their own.
const LETTER = /\p{L}/u;
const ARABIC = /\p{Script=Arabic}/u;

export interface LetterCounts {
  /** Letters in the Arabic script. */
  arabic: number;
  /** Letters in any script. */
  letters: number;
}

export function countLetters(text: string): LetterCounts {
  let arabic = 0;
  let letters = 0;
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    letters += 1;
    if (ARABIC.test(ch)) arabic += 1;
  }
  return { arabic, letters };
}

/** The share of the text's letters written in Arabic script; 0 with no letters. */
export function arabicShare(text: string): number {
  const { arabic, letters } = countLetters(text);
  return letters === 0 ? 0 : arabic / letters;
}

/** Fewer Arabic letters than this is a stray word, not an Arabic message. */
export const MIN_ARABIC_LETTERS = 2;
/**
 * A message gets the Translate link from this share of Arabic letters.
 * Low on purpose: customers mix English words into Arabic messages.
 */
export const ARABIC_MESSAGE_SHARE = 0.3;
/** A draft at or above this share is already Arabic: no Translate to Arabic. */
export const ARABIC_DRAFT_SHARE = 0.6;

export function hasArabicText(text: string | null | undefined): boolean {
  if (!text) return false;
  const { arabic, letters } = countLetters(text);
  return (
    arabic >= MIN_ARABIC_LETTERS && arabic / letters >= ARABIC_MESSAGE_SHARE
  );
}

export function isMostlyArabic(text: string): boolean {
  return arabicShare(text) >= ARABIC_DRAFT_SHARE;
}

// A text message, or the caption on a photo or video. A document's
// content_text is its file name, which is not worth translating.
const TRANSLATABLE: ReadonlySet<ContentType> = new Set<ContentType>([
  'text',
  'image',
  'video',
]);

/** Whether a thread message offers Translate: a customer's text or caption in Arabic. */
export function canTranslateMessage(message: {
  sender_type: SenderType;
  content_type: ContentType;
  content_text?: string | null;
}): boolean {
  return (
    message.sender_type === 'customer' &&
    TRANSLATABLE.has(message.content_type) &&
    hasArabicText(message.content_text)
  );
}
