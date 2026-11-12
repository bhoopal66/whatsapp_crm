import { describe, expect, it } from 'vitest';

import { BANKS, PARTNER_BANK_CODES } from '@/lib/typesafe/banks';

import {
  BANK_THEMES,
  FALLBACK_THEMES,
  bankTheme,
  contrast,
  type BankTheme,
} from './theme';

/** Known banks with no colour of their own: they use the fallback. */
const UNTHEMED = ['CBD', 'NBQ', 'CBI', 'INVESTBANK'];

const all: [string, BankTheme][] = [
  ...Object.entries(BANK_THEMES),
  ...FALLBACK_THEMES.map((t, i): [string, BankTheme] => [`fallback ${i}`, t]),
];

describe('bank tag colours', () => {
  it('measures contrast the WCAG way', () => {
    expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#777777')).toBeCloseTo(1, 5);
  });

  it.each(all)('%s keeps its text readable (AA, 4.5:1)', (_, t) => {
    expect(contrast(t.fg, t.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(all.filter(([, t]) => t.accent))(
    '%s keeps its icon visible (3:1)',
    (_, t) => {
      expect(contrast(t.accent!, t.bg)).toBeGreaterThanOrEqual(3);
    }
  );

  it('colours every bank the app knows, apart from the listed few', () => {
    const codes = BANKS.map((b) => b.code);
    expect(Object.keys(BANK_THEMES).sort()).toEqual(
      codes.filter((c) => !UNTHEMED.includes(c)).sort()
    );
  });

  it('gives each partner bank its own colour', () => {
    const fills = PARTNER_BANK_CODES.map((c) => BANK_THEMES[c]?.bg);
    expect(fills.every(Boolean)).toBe(true);
    expect(new Set(fills).size).toBe(PARTNER_BANK_CODES.length);
  });

  it('reads codes case-insensitively and keeps an unknown bank on one fallback', () => {
    expect(bankTheme(' fab ')).toBe(BANK_THEMES.FAB);
    expect(FALLBACK_THEMES).toContain(bankTheme('CBD'));
    expect(bankTheme('CUSTOM_1')).toBe(bankTheme('custom_1'));
    // Different codes spread over the palette rather than sharing one.
    const picked = new Set(
      ['CBD', 'NBQ', 'CBI', 'INVESTBANK', 'X1', 'X2', 'X3'].map(bankTheme)
    );
    expect(picked.size).toBeGreaterThan(1);
  });
});
