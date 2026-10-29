import { countLetters, isMostlyArabic } from './detect';
import { TRANSLATE_MAX_CHARS } from './limits';

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

/**
 * What the composer does with a translation that came back: `apply` it to
 * the box, keep the box because the agent `changed` the text meanwhile
 * (anything typed since must win), or drop it because the composer has
 * `moved` to another chat (it outlives a chat switch, and the Arabic of
 * chat A must never land in chat B's box).
 */
export type TranslationLanding = 'apply' | 'changed' | 'moved';

export function landTranslation(args: {
  requested: string;
  requestedChat: string;
  currentText: string;
  currentChat: string | null;
}): TranslationLanding {
  if (args.currentChat !== args.requestedChat) return 'moved';
  return args.currentText === args.requested ? 'apply' : 'changed';
}
