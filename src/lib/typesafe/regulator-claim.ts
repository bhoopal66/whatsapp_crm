/**
 * Regulator and bank/lender self-claims in a bot draft — the guardrail's
 * CODE_REGULATOR_CLAIM. Taamul is a Dubai financial broking firm and
 * Direct Sales Agent: it must never be described as registered with,
 * licensed, regulated or approved by the Central Bank of the UAE
 * (CBUAE), nor as a bank or a lender. The rule is absolute, so this is
 * a dictionary check (EN + AR) rather than a model question, and it
 * reads only the draft: the customer's text and the knowledge excerpts
 * are never consulted, so a source that makes the same claim does not
 * excuse it.
 *
 * Judged per sentence:
 *  - `regulator`: the sentence names the central bank (CBUAE, "Central
 *    Bank", المصرف/البنك المركزي, مصرف الإمارات العربية المتحدة المركزي)
 *    and a status word (registered, licensed, regulated, authorised,
 *    approved by, supervision; مرخص, مسجل, خاضع, إشراف…), and is not
 *    plainly about someone else: it fires when the sentence refers to
 *    us (we, our, Taamul, نحن, …) or names no other bank. "Mashreq is
 *    regulated by the Central Bank" does not fire; "We work with banks
 *    regulated by the Central Bank" does — a person reviews it, which is
 *    the side to err on. Any "Central Bank" counts as the UAE's: this
 *    bot only ever talks about UAE banking.
 *  - `bank_or_lender`: "we are / Taamul is a … bank / lender",
 *    "we lend", نحن بنك / نحن جهة إقراض / نقرض. Negations ("we are not
 *    a bank", "we don't lend", لسنا بنكاً) and "we are a bank partner /
 *    the bank's agent" do not fire. "We offer loans" does not either:
 *    a DSA offers its partner banks' loans.
 */
import { BANKS, detectBanksIn, normaliseArabic, type BankEntry } from './banks';

export type RegulatorClaimKind = 'regulator' | 'bank_or_lender';

/** An Arabic letter: Arabic has no `\b`, so word edges are spelled out. */
const AR = '\\u0600-\\u06FF';

// Patterns run on normaliseArabic(lower-cased text): أ/إ/آ → ا, ة → ه, ى → ي.
const REGULATOR = new RegExp(
  [
    String.raw`\bcbuae\b`,
    String.raw`\bcentral\s+bank\b`,
    String.raw`(?:مصرف|بنك)\s+(?:الامارات\s+(?:العربيه\s+المتحده\s+)?)?(?:ال|لل)?مركزي`,
  ].join('|'),
  'g'
);

const STATUS = new RegExp(
  [
    String.raw`\bregist(?:ered|ers|ration)\b`,
    // "trade licence" is everyday vocabulary here (account opening).
    String.raw`(?<!\btrade\s)\blicen[cs](?:e|es|ed|ee|ing)\b`,
    String.raw`\bregulat(?:ed|es|ors?)\b`,
    String.raw`\bauthori[sz](?:ed|es|ation)\b`,
    String.raw`\bapproved\s+by\b`,
    String.raw`-approved\b`,
    String.raw`\baccredit(?:ed|ation)\b`,
    String.raw`\bsupervis(?:ed|es|ion|ors?)\b`,
    String.raw`\boversight\b`,
    'مرخص',
    'ترخيص(?!\\s*تجاري)',
    'رخصه(?!\\s*تجاريه)',
    'مسجل',
    'تسجيل',
    'خاضع',
    'اشراف',
    'رقابه',
    'معتمد',
  ].join('|')
);

/** The sentence refers to the business itself. */
const SELF = new RegExp(
  [
    String.raw`\b(?:we|us|our|ours|ourselves|taamul)\b`,
    `(?<![${AR}])(?:نحن|اننا|انا|تعامل)(?![${AR}])`,
    // First-person plural suffix: شركتنا, لدينا, لنا.
    `[${AR}]نا(?![${AR}])`,
  ].join('|')
);

/** A bank other than the central bank, named generically. */
const OTHER_BANK = new RegExp(
  [
    String.raw`\b(?:banks?|lenders?|financial\s+institutions?)\b`,
    `(?<![${AR}])(?:و|ال|لل|بال)?(?:بنوك|مصارف|بنك|مصرف)`,
  ].join('|')
);

const BANK_OR_LENDER = [
  // "we are a bank", "Taamul is a licensed lender" — not "we are not a
  // bank", "a broker, not a bank", "a bank partner", "the bank's agent".
  new RegExp(
    String.raw`\b(?:we|taamul)(?:\s+(?:is|are|am)|'re|'s)\s+(?:also\s+|actually\s+|itself\s+)?(?:a|an|the|your)\s+(?:[a-z-]+\s+){0,2}?(?:bank|lender|lending\s+(?:company|institution|firm)|finance\s+company|financial\s+institution)\b(?!'s|[\s-]+(?:partner|agent|account|loan|product|representative|channel|branch|statement|transfer|sales|employee|staff)s?\b)`
  ),
  // "we lend", "we can lend", "we'll lend", "Taamul lends" — not "we don't lend".
  /\b(?:we|taamul)(?:'ll|\s+(?:can|will|also|directly|do|ourselves))*\s+lends?\b/,
  new RegExp(
    `(?<![${AR}])(?:نحن|اننا|انا)\\s+(?:(?:ال|لل)?(?:بنك|مصرف)(?:ا)?(?![${AR}])|جهه\\s+(?:اقراض|تمويل)(?![${AR}])|مقرض|شركه\\s+(?:اقراض|تمويل)(?![${AR}]))`
  ),
  // نقرض / ونقرض (we lend) — not لا/لن/لم نقرض.
  new RegExp(`(?<!(?:لا|لن|لم)\\s)(?<![${AR}])و?نقرض`),
];

/** Sentences of a draft. "U.A.E." is joined first so it ends none. */
function sentences(text: string): string[] {
  return normaliseArabic(text.toLowerCase().replace(/[’‘]/g, "'"))
    .replace(/\bu\.a\.e\b\.?/g, 'uae')
    .split(/(?<=[.!?؟؛;])\s+|\n+/)
    .filter((s) => s.trim());
}

/**
 * The claims a draft makes about the business's own status, each kind
 * once; empty when it makes none. `banks` is the dictionary used to
 * recognise a named third-party bank (the account's catalogue, so a
 * custom partner counts too).
 */
export function regulatorClaims(
  draft: string,
  banks: readonly BankEntry[] = BANKS
): RegulatorClaimKind[] {
  const out = new Set<RegulatorClaimKind>();
  for (const s of sentences(draft)) {
    if (BANK_OR_LENDER.some((re) => re.test(s))) out.add('bank_or_lender');
    if (!s.match(REGULATOR) || !STATUS.test(s)) continue;
    const rest = s.replace(REGULATOR, ' ');
    const aboutOthers =
      OTHER_BANK.test(rest) || detectBanksIn(rest, banks).length > 0;
    if (SELF.test(s) || !aboutOthers) out.add('regulator');
  }
  return [...out];
}
