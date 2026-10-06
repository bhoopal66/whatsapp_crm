/**
 * Deterministic bank-name dictionary (EN + AR). Runs before and after TypeSafe;
 * a dictionary hit is authoritative, the Noul only catches paraphrases.
 * Host may extend via detectBanks(text, extraBanks).
 */

export interface BankEntry {
  code: string;
  partner: boolean;
  /** Case-insensitive full names (EN). */
  names: string[];
  /** Case-sensitive acronyms, matched on word boundaries. */
  acronyms?: string[];
  /** Arabic names, matched after Arabic normalisation. */
  arabic?: string[];
}

export const PARTNER_BANK_CODES = [
  'MASHREQ',
  'RAKBANK',
  'NBF',
  'WIO',
  'RUYA',
  'UBL',
] as const;

export const BANKS: BankEntry[] = [
  // Partner banks
  {
    code: 'MASHREQ',
    partner: true,
    names: ['mashreq', 'mashreqbank', 'mashreq neo'],
    arabic: ['بنك المشرق', 'مصرف المشرق', 'المشرق بنك'],
  },
  {
    code: 'RAKBANK',
    partner: true,
    names: ['rakbank', 'rak bank', 'national bank of ras al khaimah'],
    acronyms: ['RAK'],
    arabic: ['راك بنك', 'بنك راس الخيمه', 'بنك راس الخيمه الوطني'],
  },
  {
    code: 'NBF',
    partner: true,
    names: ['national bank of fujairah'],
    acronyms: ['NBF'],
    arabic: ['بنك الفجيره الوطني', 'بنك الفجيره'],
  },
  {
    code: 'WIO',
    partner: true,
    names: ['wio bank', 'wio business', 'wio'],
    arabic: ['بنك وايو', 'وايو بنك', 'بنك ويو'],
  },
  {
    code: 'RUYA',
    partner: true,
    names: ['ruya', 'ruya bank', 'ruya community islamic bank'],
    arabic: ['بنك رؤيه', 'مصرف رؤيه', 'بنك رويه'],
  },
  {
    code: 'UBL',
    partner: true,
    names: ['united bank limited', 'ubl bank'],
    acronyms: ['UBL'],
    arabic: ['بنك يونايتد', 'يو بي ال'],
  },
  // Common non-partner banks (UAE retail / SME)
  {
    code: 'ENBD',
    partner: false,
    names: ['emirates nbd', 'emiratesnbd', 'enbd', 'liv bank', 'liv'],
    acronyms: ['ENBD'],
    arabic: ['الامارات دبي الوطني', 'بنك الامارات دبي'],
  },
  {
    code: 'FAB',
    partner: false,
    names: ['first abu dhabi bank'],
    acronyms: ['FAB'],
    arabic: ['بنك ابوظبي الاول', 'بنك ابو ظبي الاول'],
  },
  {
    code: 'ADCB',
    partner: false,
    names: ['abu dhabi commercial bank', 'al hilal bank', 'adcb'],
    acronyms: ['ADCB'],
    arabic: ['بنك ابوظبي التجاري', 'بنك ابو ظبي التجاري', 'مصرف الهلال'],
  },
  {
    code: 'DIB',
    partner: false,
    names: ['dubai islamic bank', 'dubai islamic'],
    acronyms: ['DIB'],
    arabic: ['بنك دبي الاسلامي'],
  },
  {
    code: 'ADIB',
    partner: false,
    names: ['abu dhabi islamic bank', 'adib'],
    acronyms: ['ADIB'],
    arabic: ['مصرف ابوظبي الاسلامي', 'مصرف ابو ظبي الاسلامي'],
  },
  {
    code: 'CBD',
    partner: false,
    names: ['commercial bank of dubai', 'cbd bank'],
    arabic: ['بنك دبي التجاري'],
  },
  {
    code: 'EIB',
    partner: false,
    names: ['emirates islamic', 'emirates islamic bank'],
    arabic: ['الامارات الاسلامي'],
  },
  {
    code: 'SIB',
    partner: false,
    names: ['sharjah islamic bank'],
    acronyms: ['SIB'],
    arabic: ['بنك الشارقه الاسلامي'],
  },
  {
    code: 'AJMAN',
    partner: false,
    names: ['ajman bank'],
    arabic: ['مصرف عجمان'],
  },
  { code: 'HSBC', partner: false, names: ['hsbc'], arabic: ['اتش اس بي سي'] },
  {
    code: 'SCB',
    partner: false,
    names: ['standard chartered'],
    arabic: ['ستاندرد تشارترد'],
  },
  { code: 'CITI', partner: false, names: ['citibank', 'citi bank'] },
  { code: 'ZAND', partner: false, names: ['zand bank', 'zand'] },
  {
    code: 'ARABBANK',
    partner: false,
    names: ['arab bank'],
    arabic: ['البنك العربي'],
  },
  {
    code: 'NBQ',
    partner: false,
    names: [
      'national bank of umm al qaiwain',
      'national bank of umm al quwain',
    ],
    acronyms: ['NBQ'],
  },
  { code: 'INVESTBANK', partner: false, names: ['invest bank', 'investbank'] },
  {
    code: 'CBI',
    partner: false,
    names: ['commercial bank international'],
    acronyms: ['CBI'],
  },
  { code: 'BOB', partner: false, names: ['bank of baroda'] },
];

/** Normalises Arabic letter variants so spelling differences still match. */
export function normaliseArabic(s: string): string {
  return s
    .replace(/[ً-ْـ]/g, '') // harakat + tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface BankHit {
  code: string;
  partner: boolean;
}

/**
 * Lower-case and collapse spaces, hyphens and underscores so "Emirates-NBD" /
 * "Emirates  NBD" match. Dots are kept: collapsing them made "invest. Bank
 * statements" read as Invest Bank.
 */
const normaliseLatin = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/[\s\-_]+/g, ' ')
    .trim()} `;

export function detectBanks(text: string, extra: BankEntry[] = []): BankHit[] {
  const lower = normaliseLatin(text);
  const ar = normaliseArabic(text);
  const hits = new Map<string, BankHit>();
  for (const b of [...BANKS, ...extra]) {
    let found = b.names.some((n) =>
      new RegExp(
        `(^|[^a-z0-9])${escape(normaliseLatin(n).trim())}([^a-z0-9]|$)`
      ).test(lower)
    );
    if (!found && b.acronyms)
      found = b.acronyms.some((a) =>
        new RegExp(`(^|[^A-Za-z0-9])${escape(a)}([^A-Za-z0-9]|$)`).test(text)
      );
    if (!found && b.arabic)
      found = b.arabic.some((a) => ar.includes(normaliseArabic(a)));
    if (found) hits.set(b.code, { code: b.code, partner: b.partner });
  }
  // "RAK" alone also appears inside non-bank phrases ("RAK free zone"); only count when not followed by a zone word.
  if (
    hits.has('RAKBANK') &&
    !/rak\s*bank|ras al khaimah|راك بنك|بنك راس/i.test(normaliseArabic(text))
  ) {
    if (/\bRAK\s+(free|economic|ez|icc|maritime|zone)/i.test(text))
      hits.delete('RAKBANK');
  }
  return [...hits.values()];
}

/** Display names sent to TypeSafe as `partner_banks`. */
export const PARTNER_BANK_DISPLAY: readonly string[] = [
  'Mashreq',
  'RAKBANK',
  'National Bank of Fujairah (NBF)',
  'Wio Bank',
  'Ruya Community Islamic Bank',
  'United Bank Limited (UBL)',
];
