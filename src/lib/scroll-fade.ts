/**
 * Edge fades for a sideways-scrolling row (the Settings and AI Agents
 * tab rows on a phone). Without one a row is cut hard at the edge
 * ("hatsApp") and nothing says there is more. Pure, so the rule is
 * tested; `ScrollFadeRow` measures and applies it.
 */
export interface ScrollFadeEdges {
  /** Content hidden to the left. */
  start: boolean;
  /** Content hidden to the right. */
  end: boolean;
}

/** Sub-pixel layouts leave a fraction over; that is not overflow. */
const TOLERANCE_PX = 1;

export function scrollFadeEdges(el: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}): ScrollFadeEdges {
  const hidden = el.scrollWidth - el.clientWidth;
  if (hidden <= TOLERANCE_PX) return { start: false, end: false };
  return {
    start: el.scrollLeft > TOLERANCE_PX,
    end: el.scrollLeft < hidden - TOLERANCE_PX,
  };
}

/** The `mask-image` for those edges; undefined (no mask) when neither. */
export function scrollFadeMask(
  edges: ScrollFadeEdges,
  sizePx = 24
): string | undefined {
  const { start, end } = edges;
  if (!start && !end) return undefined;
  const stops = [
    start ? `transparent, #000 ${sizePx}px` : '#000',
    end ? `#000 calc(100% - ${sizePx}px), transparent` : '#000',
  ];
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
