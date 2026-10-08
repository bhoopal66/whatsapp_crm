/**
 * How a chat tag's colour is drawn. The chip is a translucent tint of
 * the tag colour with a stronger border; its text stays the theme's
 * foreground colour (the UI sets it), so legibility never depends on
 * which colour an admin picked, in light or dark mode.
 */

/** Slate, the palette's neutral — used for anything unreadable. */
const FALLBACK_COLOR = '#64748b';

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** The tag's colour as lowercase `#rrggbb`, or slate when it isn't one. */
export function chatTagColor(color: string | null | undefined): string {
  return color && HEX_RE.test(color) ? color.toLowerCase() : FALLBACK_COLOR;
}

/** Inline style for a tag chip: 14% fill and 45% border of its colour. */
export function chatTagChipStyle(color: string | null | undefined): {
  backgroundColor: string;
  borderColor: string;
} {
  const hex = chatTagColor(color);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return {
    backgroundColor: `rgba(${r}, ${g}, ${b}, 0.14)`,
    borderColor: `rgba(${r}, ${g}, ${b}, 0.45)`,
  };
}
