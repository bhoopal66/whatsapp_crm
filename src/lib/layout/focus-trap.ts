/**
 * Tab-key wrapping for the phone menu drawer. Pure so it can be tested
 * without a DOM: the caller passes how many focusable elements the
 * drawer holds, which one has focus (-1 when focus is outside it) and
 * whether Shift is held; the answer is the index to focus, or null to
 * leave the browser's own Tab alone.
 */
export function trapTabTarget(
  count: number,
  activeIndex: number,
  shift: boolean
): number | null {
  if (count <= 0) return null;
  if (activeIndex < 0) return shift ? count - 1 : 0;
  if (shift && activeIndex === 0) return count - 1;
  if (!shift && activeIndex === count - 1) return 0;
  return null;
}

/** The tabs of the phone bottom bar, in order; More is always last. */
export const MOBILE_TAB_HREFS = [
  '/inbox',
  '/worklist',
  '/contacts',
  '/chat',
] as const;
