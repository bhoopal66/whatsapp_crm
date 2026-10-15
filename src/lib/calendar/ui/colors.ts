import { EVENT_COLORS, type EventColor } from '../validate';

/**
 * Event colours are CSS variables declared under the calendar's wrapper
 * (`paletteCss`), so one event chip reads well in light and dark mode.
 * `--cal-<c>` is the hue (border, dot), `--cal-<c>-soft` the chip fill.
 */
const HUES: Record<EventColor, { light: string; dark: string }> = {
  blue: { light: 'oklch(0.58 0.17 255)', dark: 'oklch(0.7 0.14 255)' },
  green: { light: 'oklch(0.6 0.15 150)', dark: 'oklch(0.72 0.14 150)' },
  red: { light: 'oklch(0.58 0.2 25)', dark: 'oklch(0.7 0.16 25)' },
  amber: { light: 'oklch(0.72 0.16 75)', dark: 'oklch(0.8 0.14 80)' },
  violet: { light: 'oklch(0.56 0.2 295)', dark: 'oklch(0.7 0.16 295)' },
  pink: { light: 'oklch(0.62 0.2 350)', dark: 'oklch(0.74 0.15 350)' },
  teal: { light: 'oklch(0.6 0.11 195)', dark: 'oklch(0.74 0.11 195)' },
  slate: { light: 'oklch(0.55 0.03 260)', dark: 'oklch(0.7 0.03 260)' },
};

export function safeColor(color: unknown): EventColor {
  return (EVENT_COLORS as readonly unknown[]).includes(color)
    ? (color as EventColor)
    : 'slate';
}

export function colorVar(color: unknown, part: 'solid' | 'soft'): string {
  const c = safeColor(color);
  return part === 'solid' ? `var(--cal-${c})` : `var(--cal-${c}-soft)`;
}

function declarations(mode: 'light' | 'dark'): string {
  const mix = mode === 'light' ? 16 : 28;
  return EVENT_COLORS.map((c) => {
    const hue = HUES[c][mode];
    return `--cal-${c}: ${hue}; --cal-${c}-soft: color-mix(in oklab, ${hue} ${mix}%, var(--card));`;
  }).join(' ');
}

/** The palette, declared under `scope` for light and for dark mode. */
export function paletteCss(scope: string): string {
  return `${scope} { ${declarations('light')} }\nhtml[data-mode='dark'] ${scope} { ${declarations('dark')} }`;
}
