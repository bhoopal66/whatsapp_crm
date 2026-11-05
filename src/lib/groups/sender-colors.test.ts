import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assignSenderColors,
  NEUTRAL_SENDER_COLOR,
  SENDER_COLORS,
  senderColors,
  senderKey,
} from './sender-colors';

const COLORS = SENDER_COLORS.length;

const slotOf = (color: unknown) =>
  SENDER_COLORS.indexOf(color as (typeof SENDER_COLORS)[number]);

/** How far apart two slots sit on the wheel. */
const wheelGap = (a: number, b: number) => {
  const d = Math.abs(a - b);
  return Math.min(d, COLORS - d);
};

/** A chat's senders as the data holds them: UUIDs and phone numbers. */
function people(seed: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    i % 2
      ? `wa:9715${String(seed * 7919 + i * 104729).padStart(8, '0')}`
      : `user:${seed.toString(16).padStart(8, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`
  );
}

const CHATS = 2000;

/** A colour's own slot: what it gets in a chat nobody else is in. */
const ownColor = (key: string) => assignSenderColors([key]).get(key);

// Colour maths for the measurements below (OKLab, then WCAG luminance).
type Lab = { L: number; a: number; b: number };

const theme = readFileSync(
  join(process.cwd(), 'node_modules/tailwindcss/theme.css'),
  'utf8'
);
const globals = readFileSync(
  join(process.cwd(), 'src/app/globals.css'),
  'utf8'
);

const oklch = (L: number, C: number, h: number): Lab => ({
  L,
  a: C * Math.cos((h * Math.PI) / 180),
  b: C * Math.sin((h * Math.PI) / 180),
});

/** `red-700` from Tailwind's theme. */
function tailwindColor(name: string): Lab {
  const m = new RegExp(
    `--color-${name}: oklch\\(([\\d.]+)% ([\\d.]+) ([\\d.]+)\\)`
  ).exec(theme);
  if (!m) throw new Error(`no ${name} in Tailwind's theme`);
  return oklch(Number(m[1]) / 100, Number(m[2]), Number(m[3]));
}

/** A class string's colours, light mode first. */
const shades = (classes: string) =>
  [...classes.matchAll(/(?:text|border)-([a-z]+-\d+)/g)].map((m) =>
    tailwindColor(m[1])
  );

function luminanceOfLab({ L, a, b }: Lab): number {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return (
    0.2126 * clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) +
    0.7152 * clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) +
    0.0722 * clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  );
}

/** A `--wa-bubble-*` value: a hex, or oklch with a plain lightness. */
function luminanceOfToken(value: string): number {
  const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (m) return luminanceOfLab(oklch(Number(m[1]), Number(m[2]), Number(m[3])));
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(value.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A bubble's luminance, light mode first (globals.css declares dark first). */
function bubble(side: 'in' | 'out'): number[] {
  const values = [
    ...globals.matchAll(new RegExp(`--wa-bubble-${side}: ([^;]+);`, 'g')),
  ].map((m) => luminanceOfToken(m[1]));
  expect(values).toHaveLength(2);
  return values.reverse();
}

const contrast = (a: number, b: number) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

const distance = (p: Lab, q: Lab) =>
  Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);

/** The two closest colours of the palette, in one mode of one class string. */
function closestPair(pick: 'text' | 'stripe', mode: 0 | 1): number {
  let closest = Infinity;
  SENDER_COLORS.forEach((x, i) =>
    SENDER_COLORS.slice(i + 1).forEach((y) => {
      closest = Math.min(
        closest,
        distance(shades(x[pick])[mode], shades(y[pick])[mode])
      );
    })
  );
  return closest;
}

describe('SENDER_COLORS', () => {
  it('writes every class out whole, with a pair for dark mode', () => {
    for (const color of [...SENDER_COLORS, NEUTRAL_SENDER_COLOR]) {
      expect(color.text).toMatch(/^text-[a-z]+-\d+ dark:text-[a-z]+-\d+$/);
      expect(color.textOut).toMatch(/^text-[a-z]+-\d+ dark:text-[a-z]+-\d+$/);
      expect(color.stripe).toMatch(
        /^border-[a-z]+-\d+ dark:border-[a-z]+-\d+$/
      );
    }
  });

  it('uses each hue once, the same one on the names and the edge', () => {
    const hueOf = (cls: string) => /-([a-z]+)-\d+/.exec(cls)?.[1];
    const hues = SENDER_COLORS.map(({ text, textOut, stripe }) => {
      expect(hueOf(text)).toBe(hueOf(stripe));
      expect(hueOf(textOut)).toBe(hueOf(stripe));
      return hueOf(text);
    });
    expect(new Set(hues).size).toBe(COLORS);
    expect(hues).not.toContain(hueOf(NEUTRAL_SENDER_COLOR.text));
  });

  it('keeps every name readable on its bubble, in both modes', () => {
    const incoming = bubble('in');
    const outgoing = bubble('out');
    for (const color of [...SENDER_COLORS, NEUTRAL_SENDER_COLOR]) {
      shades(color.text).forEach((shade, mode) =>
        expect(
          contrast(luminanceOfLab(shade), incoming[mode]),
          color.text
        ).toBeGreaterThanOrEqual(4.5)
      );
      shades(color.textOut).forEach((shade, mode) =>
        expect(
          contrast(luminanceOfLab(shade), outgoing[mode]),
          color.textOut
        ).toBeGreaterThanOrEqual(4.5)
      );
    }
  });

  // Any two senders can draw any two colours, so the worst pair decides how
  // quickly a chat reads. For scale: emerald and teal, cut from the palette
  // as too alike, are 0.056 apart as stripes and 0.044 as names.
  it('keeps every pair of colours clearly apart', () => {
    expect(closestPair('stripe', 0)).toBeGreaterThanOrEqual(0.09);
    expect(closestPair('stripe', 1)).toBeGreaterThanOrEqual(0.1);
    expect(closestPair('text', 0)).toBeGreaterThanOrEqual(0.06);
    expect(closestPair('text', 1)).toBeGreaterThanOrEqual(0.1);
  });
});

describe('senderKey', () => {
  it('names the user behind a CRM send, whatever else the row carries', () => {
    // A send whose webhook echo won the race carries our number as well.
    expect(
      senderKey({ sender_user_id: 'u1', sender_wa_id: '971500000001' })
    ).toBe('user:u1');
  });

  it('goes by the number, not the name WhatsApp gave it', () => {
    expect(
      senderKey({ sender_wa_id: '971500000001', sender_name: 'Sara' })
    ).toBe(senderKey({ sender_wa_id: '971500000001', sender_name: 'S. K.' }));
  });

  it('keeps a hidden number apart from a real one', () => {
    expect(senderKey({ sender_wa_id: '12345@lid' })).not.toBe(
      senderKey({ sender_wa_id: '12345' })
    );
  });

  it('falls back to the name, ignoring case and spacing', () => {
    expect(senderKey({ sender_name: ' Sara ' })).toBe(
      senderKey({ sender_name: 'sara' })
    );
  });

  it('has nothing for an automatic message or an unnamed sender', () => {
    expect(
      senderKey({ sender_user_id: 'u1', system_kind: 'welcome' })
    ).toBeNull();
    expect(senderKey({})).toBeNull();
    expect(senderKey({ sender_name: '   ' })).toBeNull();
  });
});

describe('assignSenderColors', () => {
  it('gives everyone a colour of their own while the palette lasts', () => {
    for (let seed = 1; seed <= CHATS; seed++) {
      const colors = assignSenderColors(people(seed, COLORS));
      expect(colors.size).toBe(COLORS);
      expect(new Set(colors.values()).size).toBe(COLORS);
    }
  });

  // Which messages are loaded decides the order senders first appear in, so
  // the same people must not be repainted when that order changes.
  it('gives the same people the same colours whoever wrote first', () => {
    for (let seed = 1; seed <= CHATS; seed++) {
      const everyone = people(seed, 6);
      const colors = assignSenderColors(everyone);
      const reversed = assignSenderColors([...everyone].reverse());
      const rotated = assignSenderColors([
        ...everyone.slice(2),
        ...everyone.slice(0, 2),
      ]);
      for (const [key, color] of colors) {
        expect(reversed.get(key)).toBe(color);
        expect(rotated.get(key)).toBe(color);
      }
    }
  });

  it('moves nobody when a sender arrives with a free colour', () => {
    let arrivals = 0;
    for (let seed = 1; seed <= CHATS; seed++) {
      const [newcomer, ...others] = people(seed, 6);
      const before = assignSenderColors(others);
      if ([...before.values()].includes(ownColor(newcomer)!)) continue;
      arrivals++;
      const after = assignSenderColors([...others, newcomer]);
      for (const [key, color] of before) expect(after.get(key)).toBe(color);
    }
    expect(arrivals).toBeGreaterThan(CHATS / 4);
  });

  it('gives a person the same colour in every chat where nobody clashes', () => {
    const [sara] = people(1, 1);
    let chats = 0;
    for (let seed = 2; seed <= 200; seed++) {
      const other = people(seed, 2)[1];
      if (ownColor(other) === ownColor(sara)) continue;
      chats++;
      expect(assignSenderColors([other, sara]).get(sara)).toBe(ownColor(sara));
    }
    expect(chats).toBeGreaterThan(100);
  });

  it('sends one of two clashing senders across the wheel', () => {
    let clashes = 0;
    for (let seed = 1; seed <= CHATS; seed++) {
      const [a, b] = people(seed, 2);
      if (ownColor(a) !== ownColor(b)) continue;
      clashes++;
      const colors = assignSenderColors([a, b]);
      expect(
        wheelGap(slotOf(colors.get(a)), slotOf(colors.get(b)))
      ).toBeGreaterThan(1);
    }
    expect(clashes).toBeGreaterThan(50);
  });

  it('counts a sender once however often they write', () => {
    const [a, b] = people(4, 2);
    expect(assignSenderColors([a, b, a, a, b]).size).toBe(2);
  });

  it('shares the palette out evenly in a chat bigger than it', () => {
    const colors = assignSenderColors(people(5, COLORS * 2 + 6));
    const uses = new Map<unknown, number>();
    for (const color of colors.values())
      uses.set(color, (uses.get(color) ?? 0) + 1);
    expect(uses.size).toBe(COLORS);
    expect(Math.max(...uses.values())).toBe(3);
  });

  it('leaves out messages with nobody to colour', () => {
    expect(assignSenderColors([null, null]).size).toBe(0);
  });
});

describe('senderColors', () => {
  const agent = { direction: 'out', sender_user_id: 'u1' };
  const customer = { direction: 'in', sender_wa_id: '971500000001' };
  const automatic = {
    direction: 'out',
    sender_user_id: null,
    system_kind: 'status_update',
  };

  it('tells the senders of one chat apart', () => {
    const colorOf = senderColors([agent, customer]);
    expect(colorOf(agent)).not.toBe(colorOf(customer));
    expect(SENDER_COLORS).toContain(colorOf(agent));
    expect(SENDER_COLORS).toContain(colorOf(customer));
  });

  it('colours a message being sent like the saved one that replaces it', () => {
    const optimistic = { sender_user_id: 'u1', sender_name: 'Sara' };
    const saved = { sender_user_id: 'u1', sender_wa_id: '971500000002' };
    const colorOf = senderColors([customer, optimistic]);
    expect(colorOf(saved)).toBe(colorOf(optimistic));
  });

  it('keeps people’s colours for themselves', () => {
    const colorOf = senderColors([agent, automatic, {}]);
    expect(colorOf(automatic)).toBe(NEUTRAL_SENDER_COLOR);
    expect(colorOf({})).toBe(NEUTRAL_SENDER_COLOR);
  });
});
