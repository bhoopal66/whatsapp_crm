/**
 * Check E — pre-eligibility capture. Spec §6.5. qs-013-v0.1.
 * Select, don't generate: code finds candidate amounts/years, TypeSafe picks
 * which one answers the question, code converts to numbers and bands.
 */
import { choice, type ChoiceCriteria } from '@typesafe-ai/sdk';
import { normaliseDigits } from '../redact';

export const EMIRATES = {
  abu_dhabi: 'Abu Dhabi',
  dubai: 'Dubai',
  sharjah: 'Sharjah',
  ajman: 'Ajman',
  umm_al_quwain: 'Umm Al Quwain',
  ras_al_khaimah: 'Ras Al Khaimah',
  fujairah: 'Fujairah',
  outside_uae: 'The business is registered outside the UAE.',
  not_stated: 'The conversation does not say where the business is registered.',
} as const;

export const LEGAL_FORMS = {
  sole_establishment: 'Sole establishment or sole proprietorship.',
  llc: 'Limited liability company (LLC) licensed on the mainland.',
  free_zone_entity:
    'A company or establishment licensed in a UAE free zone (FZE, FZCO, FZ-LLC).',
  branch_of_foreign_company: 'A UAE branch of a company registered abroad.',
  civil_company: 'A civil company or professional partnership.',
  other: 'A legal form not listed here.',
  not_stated: 'The conversation does not say what legal form the business has.',
} as const;

export const TRADE_LICENCE = {
  holds_licence:
    'The customer says the business holds a valid UAE trade licence.',
  no_licence:
    'The customer says the business has no valid UAE trade licence (none yet, or it has expired).',
  not_stated:
    'The conversation does not say whether the business has a trade licence.',
} as const;

export interface Candidate {
  key: string; // c1, c2, ...
  value: number; // AED for amounts; years for durations
  snippet: string; // text around the match (already redacted)
  /** 1-based message number, matching `conversation[].n` in the state. */
  messageNo: number;
}

/** Customer messages to scan. Pass REDACTED text so phone numbers etc. never become candidates. */
export interface ScanMessage {
  n: number;
  text: string;
}

const MAGNITUDE: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  ألف: 1e3,
  الف: 1e3,
  آلاف: 1e3,
  الاف: 1e3,
  m: 1e6,
  mn: 1e6,
  mil: 1e6,
  million: 1e6,
  millions: 1e6,
  مليون: 1e6,
  ملايين: 1e6,
  bn: 1e9,
  billion: 1e9,
  مليار: 1e9,
};

const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const UNIT = String.raw`(k|thousand|mn|mil|million|millions|m|bn|billion|ألف|الف|آلاف|الاف|مليون|ملايين|مليار)`;
const CUR = String.raw`(?:aed|dhs?|dirhams?|درهم|دراهم)`;
const AMOUNT_RE = new RegExp(
  String.raw`(?:(${CUR})\s*)?${NUM}\s*${UNIT}?(?![a-z؀-ۿ])\s*(${CUR})?`,
  'gi'
);

function snippetAround(
  text: string,
  start: number,
  end: number,
  pad = 40
): string {
  const s = Math.max(0, start - pad);
  const e = Math.min(text.length, end + pad);
  return `${s > 0 ? '…' : ''}${text.slice(s, e).trim()}${e < text.length ? '…' : ''}`;
}

/** Candidate AED amounts. A bare number counts only with a currency or magnitude, or if ≥ 10,000. */
export function extractAmountCandidates(
  messages: ScanMessage[],
  max = 8
): Candidate[] {
  const out: Candidate[] = [];
  messages.forEach(({ n: messageNo, text: raw }) => {
    const text = normaliseDigits(raw);
    for (const m of text.matchAll(AMOUNT_RE)) {
      const [whole, curBefore, num, unit, curAfter] = m;
      if (!num) continue;
      const base = Number(num.replace(/,/g, ''));
      if (!Number.isFinite(base)) continue;
      const mult = unit ? (MAGNITUDE[unit.toLowerCase()] ?? 1) : 1;
      const hasCurrency = Boolean(curBefore || curAfter);
      const value = base * mult;
      // Years like "2019" and small counts are not amounts
      if (
        !hasCurrency &&
        !unit &&
        (value < 10_000 || /^(19|20)\d{2}$/.test(num))
      )
        continue;
      if (value <= 0) continue;
      const start = m.index ?? 0;
      out.push({
        key: '',
        value,
        snippet: snippetAround(text, start, start + whole.length),
        messageNo,
      });
    }
  });
  return dedupe(out)
    .slice(0, max)
    .map((c, i) => ({ ...c, key: `c${i + 1}` }));
}

/** Candidate years in business, from "N years" or "since/established YYYY". */
export function extractYearsCandidates(
  messages: ScanMessage[],
  currentYear: number,
  max = 6
): Candidate[] {
  const out: Candidate[] = [];
  const DURATION =
    /(\d{1,2}(?:\.\d)?)\s*(?:\+\s*)?(years?|yrs?|سنوات|سنة|سنين|عام|أعوام|اعوام)/gi;
  const SINCE =
    /(since|established|founded|incorporated|started|opened|in business since|منذ|تأسست|تاسست|تأسيس|تاسيس)[^0-9]{0,20}((?:19|20)\d{2})/gi;
  messages.forEach(({ n: messageNo, text: raw }) => {
    const text = normaliseDigits(raw);
    for (const m of text.matchAll(DURATION)) {
      const v = Number(m[1]);
      if (v > 0 && v <= 80)
        out.push({
          key: '',
          value: v,
          snippet: snippetAround(
            text,
            m.index ?? 0,
            (m.index ?? 0) + m[0].length
          ),
          messageNo,
        });
    }
    for (const m of text.matchAll(SINCE)) {
      const y = Number(m[2]);
      if (y <= currentYear && y >= 1950) {
        out.push({
          key: '',
          value: currentYear - y,
          snippet: snippetAround(
            text,
            m.index ?? 0,
            (m.index ?? 0) + m[0].length
          ),
          messageNo,
        });
      }
    }
  });
  return dedupe(out)
    .slice(0, max)
    .map((c, i) => ({ ...c, key: `c${i + 1}` }));
}

function dedupe(cs: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return cs.filter((c) => {
    const k = `${c.messageNo}:${c.value}:${c.snippet}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const fmtAed = (v: number) =>
  `AED ${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export function buildEligibilityQuestions(opts: {
  sectors: Record<string, string>;
  turnover: Candidate[];
  years: Candidate[];
}) {
  const sectorKeys = Object.keys(opts.sectors);
  if (sectorKeys.length > 253)
    throw new Error(
      'Too many sectors: TypeSafe Choice allows at most 255 options'
    );
  for (const reserved of ['other', 'not_stated']) {
    if (reserved in opts.sectors)
      throw new Error(`Sector key "${reserved}" is reserved`);
  }

  const turnoverCriteria: ChoiceCriteria = {};
  for (const c of opts.turnover) {
    turnoverCriteria[c.key] =
      `${fmtAed(c.value)}, from message ${c.messageNo}: "${c.snippet}"`;
  }
  turnoverCriteria.none_is_turnover =
    "None of the listed amounts is the business's annual turnover (for example it is a loan amount, a balance, a price or a monthly figure), or turnover is not stated.";

  const yearsCriteria: ChoiceCriteria = {};
  for (const c of opts.years) {
    yearsCriteria[c.key] =
      `${c.value} years, from message ${c.messageNo}: "${c.snippet}"`;
  }
  yearsCriteria.none_is_years_in_business =
    'None of the listed values is how long the business has been operating, or it is not stated.';

  return {
    emirate: choice(
      "In which emirate is the customer's business licensed, according to `conversation`?",
      EMIRATES
    ),
    legal_form: choice(
      "What is the legal form of the customer's business, according to `conversation`?",
      LEGAL_FORMS
    ),
    sector: choice(
      "Which sector best describes the customer's business activity in `conversation`?",
      {
        ...opts.sectors,
        other: 'An activity that fits none of the listed sectors.',
        not_stated: 'The conversation does not describe the business activity.',
      }
    ),
    turnover_candidate: choice(
      "Which option is the business's annual turnover (yearly sales) as stated by the customer in `conversation`?",
      turnoverCriteria
    ),
    years_candidate: choice(
      "Which option is how long the customer's business has been operating, according to `conversation`?",
      yearsCriteria
    ),
    // A Choice, not a Noul: "did not say" must be told apart from "has no
    // licence" — a low Noul meant the first and was read as the second.
    trade_licence: choice(
      'What does the customer in `conversation` say about a UAE trade licence for the business?',
      TRADE_LICENCE
    ),
  };
}

export interface EligibilityState {
  conversation: { n: number; from: 'customer' | 'taamul'; text: string }[];
}
