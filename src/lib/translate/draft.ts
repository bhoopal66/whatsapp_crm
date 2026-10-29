import { countLetters, isMostlyArabic } from './detect';

/** WhatsApp's limit on a text message; longer text is never sent, so never translated. */
export const TRANSLATE_MAX_CHARS = 4096;

/**
 * Whether the composer shows Translate to Arabic for this draft: some
 * letters to translate, not already Arabic, and short enough to send.
 */
export function canTranslateDraft(text: string): boolean {
  if (text.length > TRANSLATE_MAX_CHARS) return false;
  if (countLetters(text).letters === 0) return false;
  return !isMostlyArabic(text);
}

/** What the composer keeps after Translate to Arabic, so Undo can put the draft back. */
export interface DraftTranslation {
  original: string;
  translated: string;
}

/** Undo is offered only while the box still holds exactly the translation: any edit ends it. */
export function undoAvailable(
  state: DraftTranslation | null,
  text: string
): state is DraftTranslation {
  return state !== null && state.translated === text;
}
