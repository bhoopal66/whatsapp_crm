/**
 * Whether a keydown belongs to an input method (IME) that is still
 * composing: the Enter that picks a candidate in Korean, Chinese or
 * Japanese input must not send half a word, and the arrows and Escape
 * are the candidate list's, not ours.
 *
 * Safari ends the composition before it fires the Enter's keydown, so
 * `isComposing` is already false there; that keydown carries keyCode
 * 229. Takes the native event (`e.nativeEvent` in a React handler).
 */
export function isImeKey(e: {
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return e.isComposing === true || e.keyCode === 229;
}
