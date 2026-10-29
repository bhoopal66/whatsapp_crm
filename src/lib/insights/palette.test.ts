import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  INSIGHT_INTENT_KEYS,
  leadBand,
  sentimentBand,
  urgencyBand,
} from './bands';
import {
  INSIGHT_PALETTE,
  PALETTE_FAMILIES,
  PALETTE_KEYS,
  isPaletteKey,
  paletteFor,
  swatchOf,
  type PaletteFamily,
  type Swatch,
} from './palette';

const PART = ['chip', 'dot', 'stripe', 'text'] as const;

function* everySwatch(): Generator<[PaletteFamily, string, Swatch]> {
  for (const family of PALETTE_FAMILIES)
    for (const key of PALETTE_KEYS[family])
      yield [family, key, paletteFor(family, key as never)];
}

describe('palette families and keys', () => {
  it('has exactly the listed keys in every family, nothing more', () => {
    expect(Object.keys(INSIGHT_PALETTE).sort()).toEqual(
      [...PALETTE_FAMILIES].sort()
    );
    for (const family of PALETTE_FAMILIES)
      expect(Object.keys(INSIGHT_PALETTE[family])).toEqual([
        ...PALETTE_KEYS[family],
      ]);
  });

  it('restates the band and intent vocabularies of bands.ts', () => {
    expect(PALETTE_KEYS.intent).toEqual(INSIGHT_INTENT_KEYS);
    const leads = new Set([0, 1, 2, 3].map(leadBand));
    expect([...PALETTE_KEYS.lead].sort()).toEqual([...leads].sort());
    const urg = new Set([0, 1, 2].map(urgencyBand));
    expect([...PALETTE_KEYS.urgency].sort()).toEqual([...urg].sort());
    const moods = [0, 1, 2, 3, 4].map(sentimentBand);
    expect(moods).toEqual(PALETTE_KEYS.sentiment);
  });

  it('resolves every family and key to four non-empty strings', () => {
    let n = 0;
    for (const [, , swatch] of everySwatch()) {
      for (const part of PART) expect(swatch[part]).toMatch(/\S/);
      n++;
    }
    expect(n).toBe(5 + 5 + 4 + 3 + 10 + 6);
  });

  it('gives the colours the design names', () => {
    expect(paletteFor('lead', 'ready').chip).toContain('bg-emerald-50');
    expect(paletteFor('lead', 'hot').stripe).toContain('border-l-orange-500');
    expect(paletteFor('attention', 'ai_handoff').dot).toContain('bg-rose-');
    expect(paletteFor('attention', 'wants_person').text).toContain('violet');
    expect(paletteFor('attention', 'callback').chip).toContain('bg-sky-50');
    expect(paletteFor('sentiment', 'very_negative').chip).toContain('red');
    expect(paletteFor('intent', 'smalltalk')).toBe(
      paletteFor('intent', 'other_request')
    );
    expect(paletteFor('objection', 'eligibility').chip).toContain('purple');
    expect(paletteFor('urgency', 'none').chip).toContain('zinc');
    expect(swatchOf({ family: 'objection', key: 'price' })).toBe(
      paletteFor('objection', 'price')
    );
  });

  it('pairs every class with a dark-mode shade, and the right utility', () => {
    const prefix: Record<(typeof PART)[number], RegExp> = {
      chip: /^bg-/,
      dot: /^bg-/,
      stripe: /^border-l-/,
      text: /^text-/,
    };
    for (const [family, key, swatch] of everySwatch()) {
      for (const part of PART) {
        const classes = swatch[part].split(/\s+/);
        const light = classes.filter((c) => !c.startsWith('dark:'));
        const dark = classes.filter((c) => c.startsWith('dark:'));
        expect(dark.length, `${family}.${key}.${part}`).toBeGreaterThan(0);
        expect(light[0], `${family}.${key}.${part}`).toMatch(prefix[part]);
        // Each light utility kind has a dark counterpart.
        const kind = (c: string) => c.replace(/^dark:/, '').split('-')[0];
        const lightKinds = new Set(light.filter((c) => /\d/.test(c)).map(kind));
        const darkKinds = new Set(dark.map(kind));
        for (const k of lightKinds)
          expect(darkKinds.has(k), `${family}.${key}.${part} ${k}`).toBe(true);
        // Never a pale text shade without a light-mode pair (CLAUDE.md).
        for (const c of light)
          expect(c, `${family}.${key}.${part}`).not.toMatch(
            /^text-\w+-(300|400)$/
          );
      }
    }
  });

  it('writes every class as a whole literal in the source (Tailwind scans text)', () => {
    const src = readFileSync(new URL('./palette.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/`[^`]*\$\{/);
    for (const [family, key, swatch] of everySwatch())
      for (const part of PART)
        expect(src, `${family}.${key}.${part}`).toContain(`'${swatch[part]}'`);
  });

  it('recognises its keys and rejects others', () => {
    expect(isPaletteKey('attention', 'callback')).toBe(true);
    expect(isPaletteKey('attention', 'complaint')).toBe(false);
    expect(isPaletteKey('objection', null)).toBe(false);
  });
});
