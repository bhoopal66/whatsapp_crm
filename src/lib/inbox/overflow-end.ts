/**
 * Whether a horizontal scroller has content hidden past its end edge:
 * the Inbox filter chip row fades its right edge only then, so a row
 * that fits (or is scrolled to the end) shows its last chip unfaded.
 * `scrollLeft` is taken as a magnitude (it runs negative in RTL), and a
 * pixel of slack absorbs sub-pixel layout rounding.
 */
export function hasOverflowEnd(el: {
  scrollWidth: number;
  clientWidth: number;
  scrollLeft: number;
}): boolean {
  return el.scrollWidth - el.clientWidth - Math.abs(el.scrollLeft) > 1;
}
