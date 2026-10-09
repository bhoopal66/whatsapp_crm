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

/**
 * Text in a tag's colour, anchored to the theme's text colour: darker
 * than the tag on the light theme, lighter on the dark one, so it reads
 * as the tag's colour and stays legible on its tint. A browser without
 * `color-mix` drops the declaration and keeps the class's colour.
 */
export function chatTagTextColor(color: string | null | undefined): string {
  return `color-mix(in oklab, ${chatTagColor(color)} 55%, var(--wa-text))`;
}

/**
 * The main tag's half of a tag pill: the chip's tint, with the text
 * pulled toward the tag's colour.
 */
export function chatTagMainStyle(color: string | null | undefined): {
  backgroundColor: string;
  borderColor: string;
  color: string;
} {
  return { ...chatTagChipStyle(color), color: chatTagTextColor(color) };
}

/**
 * The sub-tag's half, joined on to the main tag: a fainter tint of the
 * sub-tag's own colour, divided from the main tag by a line in the main
 * tag's colour. Lighter than the main half, so the pair reads as one tag
 * and a detail of it.
 */
export function chatTagSubStyle(
  mainColor: string | null | undefined,
  subColor: string | null | undefined
): { backgroundColor: string; borderColor: string; borderLeftColor: string } {
  const main = chatTagChipStyle(mainColor);
  const [r, g, b] = rgb(chatTagColor(subColor));
  return {
    backgroundColor: `rgba(${r}, ${g}, ${b}, 0.06)`,
    borderColor: main.borderColor,
    borderLeftColor: main.borderColor.replace(/[\d.]+\)$/, '0.3)'),
  };
}

function rgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}
