/**
 * Bank tag colours: a known bank's tag is filled with its brand colour, so
 * staff can tell banks apart at a glance (Submission groups list and
 * header). Pure and dependency-free, so client components can import it.
 *
 * Keys are `case_banks` codes (`BANKS` in `lib/typesafe/banks.ts`). `bg`
 * is the fill, `fg` the text on it, `accent` an optional brand second
 * colour for the bank icon. `theme.test.ts` holds every `fg`/`bg` pair to
 * WCAG AA (4.5:1) and every accent to 3:1, which is why ADIB's fill is a
 * shade darker than its brand blue.
 *
 * Where the colours came from (looked up 2026-11-12):
 * - Emirates NBD: the bank's brand-assets page (#072447).
 * - Ajman Bank: orange per its branding agency's case study (shade ours).
 * - DIB: green, measured from the logo artwork; yellow accent per DIB's
 *   identity launch.
 * - ADCB, RAKBANK, ADIB, SIB, Emirates Islamic, Wio, Arab Bank, Bank of
 *   Baroda, FAB, Zand, UBL, Mashreq: brand-colour libraries (Brandfetch,
 *   BrandColorCode, SeekVectors). Not official guidelines.
 * - HSBC, Standard Chartered, Citibank: their well-known brand colours.
 * NBF and Ruya (partner banks) had no source, so they get fixed stand-in
 * colours that no other partner bank uses. CBD, NBQ, CBI and Invest Bank
 * had none either; they fall back to a stable colour from FALLBACK_THEMES,
 * like any other code.
 */

export interface BankTheme {
  /** The tag's fill. */
  bg: string;
  /** Text (and, without an accent, the icon) on the fill. */
  fg: string;
  /** The icon's colour, a brand second colour. */
  accent?: string;
}

const WHITE = '#FFFFFF';

export const BANK_THEMES: Readonly<Record<string, BankTheme>> = {
  ENBD: { bg: '#072447', fg: WHITE },
  FAB: { bg: '#0B233F', fg: WHITE, accent: '#E4002B' },
  ADCB: { bg: '#EC0100', fg: WHITE },
  // Mashreq's orange, with dark text: apart from RAKBANK's red at a glance.
  MASHREQ: { bg: '#F05A22', fg: '#1F1F1F' },
  // Stand-ins, not brand colours: no source found.
  NBF: { bg: '#047857', fg: WHITE },
  RUYA: { bg: '#155E75', fg: WHITE },
  DIB: { bg: '#0A7340', fg: WHITE, accent: '#F2C230' },
  // Brand #0187C6, darkened for white text.
  ADIB: { bg: '#0172A8', fg: WHITE },
  EIB: { bg: '#461E57', fg: WHITE },
  SIB: { bg: '#001489', fg: WHITE, accent: '#EE6600' },
  // Ajman's orange on its dark grey: three orange fills (Mashreq, Ajman,
  // Bank of Baroda) could not be told apart.
  AJMAN: { bg: '#2B2B2B', fg: WHITE, accent: '#F47920' },
  RAKBANK: { bg: '#D62222', fg: WHITE },
  WIO: { bg: '#5700FF', fg: WHITE },
  ZAND: { bg: '#222222', fg: WHITE, accent: '#F6A767' },
  UBL: { bg: '#0075BE', fg: WHITE },
  ARABBANK: { bg: '#015AAB', fg: WHITE },
  // Baroda orange as a light tag, apart from Mashreq's solid orange.
  BOB: { bg: '#FDE3D3', fg: '#8E3A09' },
  HSBC: { bg: '#DB0011', fg: WHITE },
  SCB: { bg: '#0473EA', fg: WHITE },
  CITI: { bg: '#056DAE', fg: WHITE },
};

/**
 * Any other bank: one of these, picked by its code, so a bank keeps its
 * colour everywhere. Muted on purpose, so none reads as a brand colour.
 */
export const FALLBACK_THEMES: readonly BankTheme[] = [
  { bg: '#475569', fg: WHITE },
  { bg: '#0F766E', fg: WHITE },
  { bg: '#4338CA', fg: WHITE },
  { bg: '#9D174D', fg: WHITE },
  { bg: '#92400E', fg: WHITE },
  { bg: '#047857', fg: WHITE },
  { bg: '#7E22CE', fg: WHITE },
  { bg: '#155E75', fg: WHITE },
];

/** The colours of a bank's tag; the same code always gets the same ones. */
export function bankTheme(code: string): BankTheme {
  const key = code.trim().toUpperCase();
  const known = BANK_THEMES[key];
  if (known) return known;
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return FALLBACK_THEMES[h % FALLBACK_THEMES.length];
}

/** WCAG relative luminance of a `#RRGGBB` colour. */
export function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio between two `#RRGGBB` colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
