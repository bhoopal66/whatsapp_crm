import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';

/**
 * WCAG AA for the theme tokens, computed from globals.css itself: text
 * >= 4.5:1 and shapes >= 3:1 on every surface the token is used on, in
 * both modes and every accent.
 */

const read = (path: string) =>
  readFileSync(join(process.cwd(), 'src', path), 'utf8');

const css = read('app/globals.css').replace(/\/\*[\s\S]*?\*\//g, '');

const THEMES = ['taamul', 'violet', 'emerald', 'cobalt', 'amber', 'rose'];
const MODES = ['light', 'dark'] as const;
type Mode = (typeof MODES)[number];
type Tokens = Record<string, string>;

// ---------------------------------------------------------------------
// globals.css → the tokens an element sees

const rules = [...css.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
  tokens: Object.fromEntries(
    [...m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((d) => [
      d[1],
      d[2].trim(),
    ])
  ) as Tokens,
}));

/** Every token of the rules listing one of these selectors; a later
 *  (more specific) selector wins. */
function cascade(...selectors: string[]): Tokens {
  const out: Tokens = {};
  for (const selector of selectors) {
    const matched = rules.filter((r) => r.selectors.includes(selector));
    if (matched.length === 0) throw new Error(`no rule for ${selector}`);
    for (const r of matched) Object.assign(out, r.tokens);
  }
  return out;
}

/** The page (`<html data-mode data-theme>`). */
function page(mode: Mode, theme: string): Tokens {
  const layers = [
    ':root',
    `html[data-theme='${theme}']`,
    `html[data-mode='${mode}']`,
  ];
  // Light mode has no block per accent; dark lifts each one.
  if (mode === 'dark') {
    layers.push(`html[data-mode='dark'][data-theme='${theme}']`);
  }
  return cascade(...layers);
}

/** The sidebar, dark inside a light page: what it declares itself, over
 *  what it inherits from the page. */
function lightPageNav(theme: string): Tokens {
  return {
    ...page('light', theme),
    ...cascade(
      "[data-mode='dark']",
      `html[data-theme='${theme}'] [data-mode='dark']`,
      "html[data-mode='light'] [data-nav='primary'][data-mode='dark']"
    ),
  };
}

// ---------------------------------------------------------------------
// Colour maths (sRGB 0-255 + alpha)

type Rgba = [number, number, number, number];

function oklch(L: number, C: number, hue: number, alpha: number): Rgba {
  const r = (hue * Math.PI) / 180;
  const a = C * Math.cos(r);
  const b = C * Math.sin(r);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const channel = (v: number) => {
    const x = Math.min(1, Math.max(0, v));
    return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
  };
  return [
    channel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    channel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    channel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    alpha,
  ];
}

function parse(value: string): Rgba {
  if (/^#[\da-f]{6}$/i.test(value)) {
    const at = (i: number) => parseInt(value.slice(i, i + 2), 16);
    return [at(1), at(3), at(5), 1];
  }
  const fn = value.match(/^(oklch|rgb)\(([\d.\s/]+)\)$/);
  if (!fn) throw new Error(`cannot read colour ${value}`);
  const [x, y, z, alpha = 1] = fn[2].match(/[\d.]+/g)!.map(Number);
  return fn[1] === 'oklch' ? oklch(x, y, z, alpha) : [x, y, z, alpha];
}

const over = (top: Rgba, base: Rgba): Rgba => [
  top[0] * top[3] + base[0] * (1 - top[3]),
  top[1] * top[3] + base[1] * (1 - top[3]),
  top[2] * top[3] + base[2] * (1 - top[3]),
  1,
];

function luminance([r, g, b]: Rgba): number {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function ratio(text: Rgba, surface: Rgba): number {
  const a = luminance(over(text, surface));
  const b = luminance(surface);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** `name` is a token or a literal; `/NN` as in `bg-primary/15`. */
function colour(tokens: Tokens, name: string): Rgba {
  const [base, percent] = name.split('/');
  const value = base.startsWith('#') ? base : tokens[`--${base}`];
  if (!value) throw new Error(`--${base} is not declared`);
  const [r, g, b, a] = parse(value);
  return [r, g, b, percent ? (a * Number(percent)) / 100 : a];
}

/** Contrast of `fg` on `stack`, the surfaces from the bottom up. */
function contrast(tokens: Tokens, fg: string, stack: string[]): number {
  const surface = stack
    .map((name) => colour(tokens, name))
    .reduce((base, top) => over(top, base));
  return ratio(colour(tokens, fg), surface);
}

/** Every pair below `min`, so a failure names them all at once. */
function below(
  min: number,
  tokens: Tokens,
  pairs: [fg: string, stack: string[]][]
): string[] {
  return pairs
    .map(([fg, stack]) => ({ fg, stack, c: contrast(tokens, fg, stack) }))
    .filter((p) => p.c < min)
    .map((p) => `${p.fg} on ${p.stack.join(' + ')}: ${p.c.toFixed(2)}`);
}

const on = (
  fg: string,
  surfaces: string[],
  ...tints: string[]
): [string, string[]][] => surfaces.map((s) => [fg, [s, ...tints]]);

// Where text sits. A tinted chip sits on a page, a card or a popover.
const SURFACES = [
  'background',
  'card',
  'card-2',
  'popover',
  'secondary',
  'muted',
  'accent',
];
const CHIP_BASES = ['background', 'card', 'card-2', 'popover', 'muted'];
const WA_SURFACES = [
  'wa-panel',
  'wa-panel-header',
  'wa-row-hover',
  'wa-row-active',
  'wa-search',
];
const BUBBLES = ['wa-bubble-in', 'wa-bubble-out'];

describe.each(MODES)('%s mode', (mode) => {
  describe.each(THEMES)('accent %s', (theme) => {
    const tokens = page(mode, theme);

    it('primary text reads on every surface and on its own tint', () => {
      expect(
        below(4.5, tokens, [
          ...on('primary-text', SURFACES),
          ...on('primary-text', CHIP_BASES, 'primary-soft'),
          ...on('primary-text', ['card', 'popover'], 'primary/15'),
        ])
      ).toEqual([]);
    });

    it('small print reads on an unread notification', () => {
      expect(
        below(4.5, tokens, [
          ...on('muted-foreground', ['card', 'popover'], 'primary-soft'),
        ])
      ).toEqual([]);
    });
  });

  const tokens = page(mode, 'taamul');

  it('red text reads on every surface and on its own tint', () => {
    expect(
      below(4.5, tokens, [
        ...on('destructive-text', SURFACES),
        ...on('destructive-text', CHIP_BASES, 'destructive-soft'),
        ...on('destructive-text', CHIP_BASES, 'destructive/10'),
      ])
    ).toEqual([]);
  });

  it('a red fill takes white text and shows on a card', () => {
    expect(below(4.5, tokens, [['#ffffff', ['destructive']]])).toEqual([]);
    expect(below(3, tokens, on('destructive', ['card', 'popover']))).toEqual(
      []
    );
  });

  it('muted text reads on every surface', () => {
    expect(below(4.5, tokens, on('muted-foreground', SURFACES))).toEqual([]);
  });

  it('the inbox green reads as text and under its own text', () => {
    expect(
      below(4.5, tokens, [
        ...on('wa-green', WA_SURFACES),
        ['wa-green-fg', ['wa-green']],
        ['wa-green-fg', ['wa-panel', 'wa-green/90']],
      ])
    ).toEqual([]);
  });

  it('the inbox teal reads on panels and on an active chip', () => {
    expect(
      below(4.5, tokens, on('wa-teal', [...WA_SURFACES, 'wa-chip-active']))
    ).toEqual([]);
  });

  it('time and AI badge read inside a bubble', () => {
    expect(
      below(4.5, tokens, [
        ...on('wa-meta', BUBBLES),
        ...on('wa-meta', BUBBLES, 'wa-quote'),
      ])
    ).toEqual([]);
  });

  it('the author of a quote reads in the bubble and in the composer', () => {
    const author = mode === 'dark' ? 'wa-quote-bar' : 'wa-teal';
    expect(
      below(4.5, tokens, [
        ...on(author, BUBBLES, 'wa-quote'),
        [author, ['wa-input']],
      ])
    ).toEqual([]);
  });
});

describe('the dark sidebar inside a light page', () => {
  it.each(THEMES)('keeps the lifted text of accent %s', (theme) => {
    const nav = lightPageNav(theme);
    expect(nav['--primary-text']).toBe(page('dark', theme)['--primary-text']);
    expect(
      below(4.5, nav, [
        ['primary-text', ['sidebar']],
        ['primary-text', ['sidebar', 'card']],
        ['destructive-text', ['sidebar']],
      ])
    ).toEqual([]);
  });
});

describe('Tailwind utilities', () => {
  // The app's own theme block, so the real mapping is what is compiled.
  const theme = css.match(/@theme inline \{[^{}]*\}/)![0];

  it('only text takes the text shade; fills, borders and rings do not', async () => {
    const { build } = await compile(`${theme}\n@tailwind utilities;`);
    const sheet = build([
      'text-primary',
      'text-destructive',
      'hover:text-primary/80',
      'text-primary-foreground',
      'bg-primary',
      'bg-destructive/10',
      'border-primary',
      'ring-destructive',
    ]);
    const rule = (selector: string) =>
      sheet.slice(sheet.indexOf(selector)).split(/\n {2}\}|\n\}/)[0];

    expect(rule('.text-primary {')).toContain('color: var(--primary-text);');
    expect(rule('.text-destructive {')).toContain(
      'color: var(--destructive-text);'
    );
    expect(sheet).toContain(
      'color-mix(in oklab, var(--primary-text) 80%, transparent)'
    );
    expect(rule('.text-primary-foreground {')).toContain(
      'color: var(--primary-foreground);'
    );
    expect(rule('.bg-primary {')).toContain('background-color: var(--primary)');
    expect(rule('.bg-destructive\\/10 {')).toContain('var(--destructive)');
    expect(rule('.border-primary {')).toContain('border-color: var(--primary)');
    expect(rule('.ring-destructive {')).toContain('var(--destructive)');
  });
});

describe('classes that faded text below the line', () => {
  it.each([
    [
      'components/notifications/notification-item.tsx',
      'text-muted-foreground/70',
      'text-muted-foreground mt-1 text-xs',
    ],
    [
      'components/calendar/calendar-view.tsx',
      'text-muted-foreground/60',
      "!d.inMonth && 'text-muted-foreground'",
    ],
    [
      'components/calendar/calendar-view.tsx',
      '.cal-dh--today .cal-dh__wd { color: var(--primary);',
      '.cal-dh--today .cal-dh__wd { color: var(--primary-text);',
    ],
    ['components/ui/tabs.tsx', 'text-foreground/60', 'text-muted-foreground'],
    [
      'components/inbox/message-bubble.tsx',
      'bg-wa-teal/15 text-wa-teal',
      'bg-wa-quote text-wa-meta',
    ],
    [
      'components/inbox/reply-quote.tsx',
      'text-wa-teal truncate',
      'text-wa-teal dark:text-wa-quote-bar',
    ],
  ])('%s: no %s', (file, gone, wanted) => {
    const source = read(file);
    expect(source).not.toContain(gone);
    expect(source).toContain(wanted);
  });
});
