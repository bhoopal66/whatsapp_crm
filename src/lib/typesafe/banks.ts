/**
 * Deterministic bank-name dictionary (EN + AR). Runs before and after TypeSafe;
 * a dictionary hit is authoritative, the Noul only catches paraphrases.
 * Host may extend via detectBanks(text, extraBanks); an account's own
 * partner list (migration 078) is partnerCatalogue(setting).
 */
import type { PartnerBanksSetting } from './admin-types';

export interface BankEntry {
  code: string;
  partner: boolean;
  /** How the bank is named to TypeSafe and the bot (`partner_banks`). */
  displayName: string;
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
    displayName: 'Mashreq',
    names: ['mashreq', 'mashreqbank', 'mashreq neo'],
    arabic: ['بنك المشرق', 'مصرف المشرق', 'المشرق بنك'],
  },
  {
    code: 'RAKBANK',
    partner: true,
    displayName: 'RAKBANK',
    names: ['rakbank', 'rak bank', 'national bank of ras al khaimah'],
    acronyms: ['RAK'],
    arabic: ['راك بنك', 'بنك راس الخيمه', 'بنك راس الخيمه الوطني'],
  },
  {
    code: 'NBF',
    partner: true,
    displayName: 'National Bank of Fujairah (NBF)',
    names: ['national bank of fujairah'],
    acronyms: ['NBF'],
    arabic: ['بنك الفجيره الوطني', 'بنك الفجيره'],
  },
  {
    code: 'WIO',
    partner: true,
    displayName: 'Wio Bank',
    names: ['wio bank', 'wio business', 'wio'],
    arabic: ['بنك وايو', 'وايو بنك', 'بنك ويو'],
  },
  {
    code: 'RUYA',
    partner: true,
    displayName: 'Ruya Community Islamic Bank',
    names: ['ruya', 'ruya bank', 'ruya community islamic bank'],
    arabic: ['بنك رؤيه', 'مصرف رؤيه', 'بنك رويه'],
  },
  {
    code: 'UBL',
    partner: true,
    displayName: 'United Bank Limited (UBL)',
    names: ['united bank limited', 'ubl bank'],
    acronyms: ['UBL'],
    arabic: ['بنك يونايتد', 'يو بي ال'],
  },
  // Common non-partner banks (UAE retail / SME)
  {
    code: 'ENBD',
    partner: false,
    displayName: 'Emirates NBD',
    names: ['emirates nbd', 'emiratesnbd', 'enbd', 'liv bank', 'liv'],
    acronyms: ['ENBD'],
    arabic: ['الامارات دبي الوطني', 'بنك الامارات دبي'],
  },
  {
    code: 'FAB',
    partner: false,
    displayName: 'First Abu Dhabi Bank (FAB)',
    names: ['first abu dhabi bank'],
    acronyms: ['FAB'],
    arabic: ['بنك ابوظبي الاول', 'بنك ابو ظبي الاول'],
  },
  {
    code: 'ADCB',
    partner: false,
    displayName: 'Abu Dhabi Commercial Bank (ADCB)',
    names: ['abu dhabi commercial bank', 'al hilal bank', 'adcb'],
    acronyms: ['ADCB'],
    arabic: ['بنك ابوظبي التجاري', 'بنك ابو ظبي التجاري', 'مصرف الهلال'],
  },
  {
    code: 'DIB',
    partner: false,
    displayName: 'Dubai Islamic Bank (DIB)',
    names: ['dubai islamic bank', 'dubai islamic'],
    acronyms: ['DIB'],
    arabic: ['بنك دبي الاسلامي'],
  },
  {
    code: 'ADIB',
    partner: false,
    displayName: 'Abu Dhabi Islamic Bank (ADIB)',
    names: ['abu dhabi islamic bank', 'adib'],
    acronyms: ['ADIB'],
    arabic: ['مصرف ابوظبي الاسلامي', 'مصرف ابو ظبي الاسلامي'],
  },
  {
    code: 'CBD',
    partner: false,
    displayName: 'Commercial Bank of Dubai (CBD)',
    names: ['commercial bank of dubai', 'cbd bank'],
    arabic: ['بنك دبي التجاري'],
  },
  {
    code: 'EIB',
    partner: false,
    displayName: 'Emirates Islamic',
    names: ['emirates islamic', 'emirates islamic bank'],
    arabic: ['الامارات الاسلامي'],
  },
  {
    code: 'SIB',
    partner: false,
    displayName: 'Sharjah Islamic Bank (SIB)',
    names: ['sharjah islamic bank'],
    acronyms: ['SIB'],
    arabic: ['بنك الشارقه الاسلامي'],
  },
  {
    code: 'AJMAN',
    partner: false,
    displayName: 'Ajman Bank',
    names: ['ajman bank'],
    arabic: ['مصرف عجمان'],
  },
  {
    code: 'HSBC',
    partner: false,
    displayName: 'HSBC',
    names: ['hsbc'],
    arabic: ['اتش اس بي سي'],
  },
  {
    code: 'SCB',
    partner: false,
    displayName: 'Standard Chartered',
    names: ['standard chartered'],
    arabic: ['ستاندرد تشارترد'],
  },
  {
    code: 'CITI',
    partner: false,
    displayName: 'Citibank',
    names: ['citibank', 'citi bank'],
  },
  {
    code: 'ZAND',
    partner: false,
    displayName: 'Zand Bank',
    names: ['zand bank', 'zand'],
  },
  {
    code: 'ARABBANK',
    partner: false,
    displayName: 'Arab Bank',
    names: ['arab bank'],
    arabic: ['البنك العربي'],
  },
  {
    code: 'NBQ',
    partner: false,
    displayName: 'National Bank of Umm Al Qaiwain (NBQ)',
    names: [
      'national bank of umm al qaiwain',
      'national bank of umm al quwain',
    ],
    acronyms: ['NBQ'],
  },
  {
    code: 'INVESTBANK',
    partner: false,
    displayName: 'Invest Bank',
    names: ['invest bank', 'investbank'],
  },
  {
    code: 'CBI',
    partner: false,
    displayName: 'Commercial Bank International (CBI)',
    names: ['commercial bank international'],
    acronyms: ['CBI'],
  },
  {
    code: 'BOB',
    partner: false,
    displayName: 'Bank of Baroda',
    names: ['bank of baroda'],
  },
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
  return detectBanksIn(text, [...BANKS, ...extra]);
}

/** detectBanks over a given catalogue (an account's: partnerCatalogue). */
export function detectBanksIn(
  text: string,
  banks: readonly BankEntry[]
): BankHit[] {
  const lower = normaliseLatin(text);
  const ar = normaliseArabic(text);
  const hits = new Map<string, BankHit>();
  for (const b of banks) {
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

/** An account's bank dictionary and the partner names it is told about. */
export interface PartnerCatalogue {
  /** The whole dictionary, `partner` set per the account. */
  banks: readonly BankEntry[];
  /** Display names of the partners, sent to TypeSafe as `partner_banks`. */
  display: readonly string[];
}

const ARABIC = /[؀-ۿ]/;
/** A short all-caps spelling ("AHB") is matched case-sensitively, like FAB:
 *  lower-cased it would also hit ordinary words. */
const isAcronym = (s: string) => s.length <= 5 && /^[A-Z0-9&]+$/.test(s);

function customEntry(
  bank: { name: string; aliases: string[] },
  n: number
): BankEntry {
  const names: string[] = [];
  const acronyms: string[] = [];
  const arabic: string[] = [];
  for (const s of [bank.name, ...bank.aliases]) {
    if (ARABIC.test(s)) arabic.push(s);
    else if (isAcronym(s)) acronyms.push(s);
    else names.push(s.toLowerCase());
  }
  const short = acronyms.filter((a) => a !== bank.name);
  return {
    code: `CUSTOM_${n}`,
    partner: true,
    displayName: short.length
      ? `${bank.name} (${short.join(', ')})`
      : bank.name,
    names,
    acronyms,
    arabic,
  };
}

/**
 * Removes from `b` every spelling a custom partner claims, so "Al Hilal
 * Bank" added as a partner is not also read as ADCB (whose dictionary
 * entry lists it) and blocked.
 */
function withoutSpellings(b: BankEntry, claimed: BankEntry[]): BankEntry {
  const latin = new Set(
    claimed.flatMap((c) => c.names.map((n) => normaliseLatin(n).trim()))
  );
  const acr = new Set(claimed.flatMap((c) => c.acronyms ?? []));
  const ar = new Set(
    claimed.flatMap((c) => (c.arabic ?? []).map(normaliseArabic))
  );
  return {
    ...b,
    names: b.names.filter((n) => !latin.has(normaliseLatin(n).trim())),
    acronyms: b.acronyms?.filter((a) => !acr.has(a)),
    arabic: b.arabic?.filter((a) => !ar.has(normaliseArabic(a))),
  };
}

const DEFAULT_CATALOGUE: PartnerCatalogue = {
  banks: BANKS,
  display: BANKS.filter((b) => b.partner).map((b) => b.displayName),
};

/**
 * The bank dictionary as one account sees it. `null` (no setting saved)
 * is the built-in partner list. Otherwise a built-in bank is a partner
 * when its code is in `setting.codes` (unknown codes are ignored), and
 * each custom bank is a partner entry `CUSTOM_<n>` whose spellings are
 * its name and aliases.
 */
export function partnerCatalogue(
  setting: PartnerBanksSetting | null
): PartnerCatalogue {
  if (!setting) return DEFAULT_CATALOGUE;
  const codes = new Set(setting.codes.map((c) => c.toUpperCase()));
  const custom = setting.custom.map((c, i) => customEntry(c, i + 1));
  const builtIn = BANKS.map((b) => {
    const partner = codes.has(b.code);
    return partner
      ? { ...b, partner }
      : withoutSpellings({ ...b, partner }, custom);
  });
  const banks = [...builtIn, ...custom];
  return {
    banks,
    display: banks.filter((b) => b.partner).map((b) => b.displayName),
  };
}

/** Display names sent to TypeSafe as `partner_banks` (the built-in list). */
export const PARTNER_BANK_DISPLAY: readonly string[] =
  DEFAULT_CATALOGUE.display;
