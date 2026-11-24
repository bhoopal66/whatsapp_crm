/** Arabic-Indic U+0660-0669 and Eastern Arabic-Indic U+06F0-06F9. */
const ARABIC_DIGITS = /[\u0660-\u0669\u06f0-\u06f9]/g;

/**
 * Arabic-Indic and Persian digits as 0-9; everything else unchanged. Any
 * code that strips non-digits (`\D`) from typed text calls this first:
 * `\D` drops those digits too, so a number typed on an Arabic keyboard
 * lost all of them.
 */
export function latinDigits(text: string): string {
  return text.replace(ARABIC_DIGITS, (c) => String(c.charCodeAt(0) & 0xf));
}
