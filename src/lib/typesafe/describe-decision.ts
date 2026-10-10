/**
 * Turns a TypeSafe decision-log row into display data for Settings → AI Agents
 * → Safety checks: which badge colour, which catalogue message, which
 * humanised reasons.
 *
 * Pure and dependency-free on purpose. It is imported by a client
 * component, so it must never reach server code — the only import is
 * type-only, from the contract file that is itself import-free.
 *
 * Every catalogue key returned here is relative to the panel's
 * namespace (`Settings.aiSafety`). A string the helper does not
 * recognise — a new decision, a new reason code — comes back with
 * `key: null` and its raw text, and the panel shows it as-is rather
 * than failing: the log is written by a backend that can ship new codes
 * before this file learns them.
 */
import type { TsActivityItem, TsCheck } from './admin-types';

/**
 * How a decision reads at a glance:
 * - `intervened` — TypeSafe changed what happened (acted);
 * - `logged` — it would have changed something, but was only logged
 *   (monitor mode, or a language kept logged-only);
 * - `passed` — nothing to change;
 * - `unavailable` — TypeSafe could not answer and a fallback applied.
 */
export type OutcomeKind = 'intervened' | 'logged' | 'passed' | 'unavailable';

/**
 * For an intervention: did it change what happened, or was it only
 * logged? `null` for a pass or a fallback, which have nothing to say.
 */
export type OutcomeEffect = 'acted' | 'logged' | null;

export type MessageParams = Record<string, string | number>;

/** A catalogue message, or raw text when `key` is null. */
export interface DisplayLabel {
  /** Key relative to `Settings.aiSafety`; null → show `raw` as-is. */
  key: string | null;
  params: MessageParams;
  /** The string as logged. Also what a tooltip shows. */
  raw: string;
}

export interface ReasonLabel extends DisplayLabel {
  /** Occurrences folded into this label (passages are summarised). */
  count: number;
}

export interface DecisionDescription {
  kind: OutcomeKind;
  effect: OutcomeEffect;
  check: DisplayLabel;
  outcome: DisplayLabel;
  reasons: ReasonLabel[];
  language: DisplayLabel | null;
}

type DescribableItem = Pick<
  TsActivityItem,
  'check' | 'decision' | 'reasonCodes' | 'acted' | 'fallbackUsed'
> &
  Partial<Pick<TsActivityItem, 'language'>>;

// ------------------------------------------------------------------
// Checks and languages
// ------------------------------------------------------------------

const KNOWN_CHECKS: readonly string[] = [
  'triage',
  'guardrail',
  'passages',
  'eligibility',
];

/** The checks an admin can filter the activity list by. */
export const FILTERABLE_CHECKS: readonly TsCheck[] = [
  'triage',
  'guardrail',
  'passages',
];

export function describeCheck(check: string): DisplayLabel {
  return {
    key: KNOWN_CHECKS.includes(check) ? `checks.${check}` : null,
    params: {},
    raw: check,
  };
}

const KNOWN_LANGUAGES: readonly string[] = [
  'en',
  'ar',
  'mixed',
  'other',
  'unknown',
];

export function describeLanguage(
  language: string | null | undefined
): DisplayLabel | null {
  if (!language) return null;
  return {
    key: KNOWN_LANGUAGES.includes(language) ? `languages.${language}` : null,
    params: {},
    raw: language,
  };
}

// ------------------------------------------------------------------
// Reasons
// ------------------------------------------------------------------

/** Reason codes with a catalogue entry of the same name under `reasons.`. */
const TRIAGE_REASONS = [
  'OPT_OUT_RECORD',
  'OPT_OUT_REVIEW',
  'OPT_OUT_WITH_HUMAN_REQUEST',
  'OPT_OUT_WITH_COMPLAINT',
  'HUMAN_REQUEST',
  'COMPLAINT',
  'TRIAGE_UNCERTAIN',
  'INSTRUCTS_ASSISTANT',
  'NON_PARTNER_BANK',
  'NON_PARTNER_BANK_MENTION',
  'DISSATISFIED',
  'LEAD_HOT_CALLBACK',
  'FALLBACK',
  // Logged by the watch on conversations people handle.
  'WATCH',
] as const;

/** Guardrail hazards; each is logged as `<HAZARD>_BLOCK` or `<HAZARD>_REVIEW`. */
export const GUARDRAIL_HAZARDS = [
  'PROMISES_APPROVAL',
  'GUARANTEES_TIMELINE',
  'UNSUPPORTED_FIGURE',
  'NON_PARTNER_BANK',
  'UNSUPPORTED_CLAIM',
  'ASKS_SECRET',
  'REVEALS_INSTRUCTIONS',
  'SHARES_THIRD_PARTY',
] as const;

const GUARDRAIL_REASONS = [
  ...GUARDRAIL_HAZARDS.flatMap((h) => [`${h}_BLOCK`, `${h}_REVIEW`]),
  'SEVERITY_UPGRADE',
  'CODE_NON_PARTNER_BANK',
  'CODE_NON_PARTNER_BANK_ECHO',
  'CODE_UNSUPPORTED_FIGURE',
  'CODE_REGULATOR_CLAIM',
  'DEGRADED_HOLD',
  'DEGRADED_SEND',
  'TS_UNAVAILABLE',
  'POLICY_UNAVAILABLE',
  'LANGUAGE_SHADOW_CODE_ONLY',
  'LANGUAGE_SHADOW_MODEL_REVIEW',
];

/** Every plain reason code the catalogue names (`reasons.<CODE>`). */
export const KNOWN_REASON_CODES: readonly string[] = [
  ...new Set<string>([...TRIAGE_REASONS, ...GUARDRAIL_REASONS]),
];

/** Per-passage verdicts, most serious first (the order they are listed in). */
export const PASSAGE_VERDICTS = [
  'INJECTION',
  'CONTRADICTS_PREMISE',
  'NOT_RELEVANT',
  'NO_EVIDENCE',
] as const;

/** Eligibility fields the bot may have to ask for again (`REASK_<field>`). */
const REASK_FIELDS: readonly string[] = [
  'emirate',
  'legalForm',
  'sector',
  'turnover',
  'yearsInBusiness',
  'hasTradeLicence',
];

const PASSAGES_FALLBACK = /^FALLBACK:(\d+)_FAILED$/;

/** One reason code, outside the passages summary. */
export function describeReason(code: string): DisplayLabel {
  if (KNOWN_REASON_CODES.includes(code)) {
    return { key: `reasons.${code}`, params: {}, raw: code };
  }
  if (code.startsWith('REASK_')) {
    const field = code.slice('REASK_'.length);
    if (REASK_FIELDS.includes(field)) {
      return { key: `reasons.reask.${field}`, params: {}, raw: code };
    }
  }
  const fallback = PASSAGES_FALLBACK.exec(code);
  if (fallback) {
    return {
      key: 'reasons.passage.FALLBACK',
      params: { count: Number(fallback[1]) },
      raw: code,
    };
  }
  return { key: null, params: {}, raw: code };
}

function sanitiseCodes(codes: unknown): string[] {
  return Array.isArray(codes)
    ? codes.filter((c): c is string => typeof c === 'string' && c !== '')
    : [];
}

/**
 * The passages check logs one `<chunkId>:<VERDICT>` per excerpt. Chunk
 * ids mean nothing to an admin, so they are counted per verdict instead.
 * `EVIDENCE` (the excerpts kept) is left out: the outcome already says
 * how many were kept.
 */
function summarisePassageReasons(codes: string[]): ReasonLabel[] {
  const counts = new Map<string, number>();
  let failed = 0;
  let fallbackCode: string | null = null;
  for (const code of codes) {
    const fallback = PASSAGES_FALLBACK.exec(code);
    if (fallback) {
      failed += Number(fallback[1]);
      fallbackCode = code;
      continue;
    }
    const at = code.lastIndexOf(':');
    const verdict = at === -1 ? code : code.slice(at + 1);
    if (verdict === 'EVIDENCE' || verdict === '') continue;
    counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
  }

  const out: ReasonLabel[] = [];
  for (const verdict of PASSAGE_VERDICTS) {
    const count = counts.get(verdict);
    if (!count) continue;
    out.push({
      key: `reasons.passage.${verdict}`,
      params: { count },
      raw: verdict,
      count,
    });
    counts.delete(verdict);
  }
  for (const [verdict, count] of counts) {
    out.push({ key: null, params: {}, raw: verdict, count });
  }
  if (fallbackCode !== null) {
    out.push({
      key: 'reasons.passage.FALLBACK',
      params: { count: failed },
      raw: fallbackCode,
      count: 1,
    });
  }
  return out;
}

/** Humanised reasons, in logged order, each code at most once. */
export function describeReasons(check: string, codes: unknown): ReasonLabel[] {
  const list = sanitiseCodes(codes);
  if (check === 'passages') return summarisePassageReasons(list);

  const byCode = new Map<string, ReasonLabel>();
  for (const code of list) {
    const seen = byCode.get(code);
    if (seen) {
      seen.count += 1;
      continue;
    }
    byCode.set(code, { ...describeReason(code), count: 1 });
  }
  return [...byCode.values()];
}

// ------------------------------------------------------------------
// Outcomes
// ------------------------------------------------------------------

export interface PassageCounts {
  include: number;
  conflict: number;
  drop: number;
}

/** Parse `include=a;conflict=b;drop=c`. Null for anything else. */
export function parsePassagesDecision(decision: string): PassageCounts | null {
  const parts = new Map<string, number>();
  for (const part of decision.split(';')) {
    const m = /^\s*(include|conflict|drop)=(\d+)\s*$/.exec(part);
    if (!m) return null;
    parts.set(m[1], Number(m[2]));
  }
  if (!parts.has('include') || !parts.has('drop')) return null;
  return {
    include: parts.get('include') ?? 0,
    conflict: parts.get('conflict') ?? 0,
    drop: parts.get('drop') ?? 0,
  };
}

interface Outcome {
  /** null → unknown decision string. */
  label: DisplayLabel | null;
  /** Does this decision change anything, when acted on? */
  intervention: boolean;
  /** The decision itself says TypeSafe was unavailable. */
  unavailable: boolean;
}

const label = (
  key: string,
  raw: string,
  params: MessageParams = {}
): DisplayLabel => ({ key, params, raw });

/** For decisions that read differently when only logged. */
const variant = (acted: boolean) => (acted ? 'acted' : 'logged');

/**
 * The watch on conversations people handle (reason code WATCH) only
 * ever records an opt-out: a person already owns the thread, so a
 * request for a person or a complaint there is noted, not acted on, and
 * nothing was "answered by the bot".
 */
function watchOutcome(decision: string, acted: boolean): Outcome | null {
  switch (decision) {
    case 'opted_out':
      return {
        label: label(`outcome.triage.optedOut.${variant(acted)}`, decision),
        intervention: true,
        unavailable: false,
      };
    case 'bot':
    case 'bot_restricted':
      return {
        label: label('outcome.triage.watched', decision),
        intervention: false,
        unavailable: false,
      };
    case 'rm':
      return {
        label: label('outcome.triage.watchedFlagged', decision),
        intervention: false,
        unavailable: false,
      };
    default:
      return triageOutcome(decision, acted);
  }
}

function triageOutcome(decision: string, acted: boolean): Outcome | null {
  switch (decision) {
    case 'bot':
      return {
        label: label('outcome.triage.bot', decision),
        intervention: false,
        unavailable: false,
      };
    case 'bot_restricted':
      return {
        label: label(
          `outcome.triage.botRestricted.${variant(acted)}`,
          decision
        ),
        intervention: true,
        unavailable: false,
      };
    case 'rm':
      return {
        label: label(`outcome.triage.rm.${variant(acted)}`, decision),
        intervention: true,
        unavailable: false,
      };
    case 'opted_out':
      return {
        label: label(`outcome.triage.optedOut.${variant(acted)}`, decision),
        intervention: true,
        unavailable: false,
      };
    case 'host_default':
      return {
        label: label('outcome.triage.hostDefault', decision),
        intervention: false,
        unavailable: true,
      };
    default:
      return null;
  }
}

function guardrailOutcome(
  decision: string,
  acted: boolean,
  fallbackUsed: boolean
): Outcome | null {
  switch (decision) {
    case 'send':
      return {
        label: label(
          fallbackUsed
            ? 'outcome.guardrail.sendUnchecked'
            : 'outcome.guardrail.send',
          decision
        ),
        intervention: false,
        unavailable: false,
      };
    case 'hold':
      return {
        label: label(`outcome.guardrail.hold.${variant(acted)}`, decision),
        intervention: true,
        unavailable: false,
      };
    case 'block':
      return {
        label: label(`outcome.guardrail.block.${variant(acted)}`, decision),
        intervention: true,
        unavailable: false,
      };
    default:
      return null;
  }
}

function passagesOutcome(decision: string, acted: boolean): Outcome | null {
  if (decision === 'fallback_top_k') {
    return {
      label: label('outcome.passages.fallback', decision),
      intervention: false,
      unavailable: true,
    };
  }
  const counts = parsePassagesDecision(decision);
  if (!counts) return null;
  const total = counts.include + counts.conflict + counts.drop;
  if (counts.drop > 0) {
    return {
      label: label(`outcome.passages.removed.${variant(acted)}`, decision, {
        drop: counts.drop,
        conflict: counts.conflict,
        total,
      }),
      intervention: true,
      unavailable: false,
    };
  }
  if (counts.conflict > 0) {
    return {
      label: label(`outcome.passages.conflicting.${variant(acted)}`, decision, {
        conflict: counts.conflict,
        total,
      }),
      intervention: true,
      unavailable: false,
    };
  }
  return {
    label: label('outcome.passages.kept', decision, { count: counts.include }),
    intervention: false,
    unavailable: false,
  };
}

function eligibilityOutcome(decision: string): Outcome | null {
  if (decision === 'complete') {
    return {
      label: label('outcome.eligibility.complete', decision),
      intervention: false,
      unavailable: false,
    };
  }
  if (decision === 'reask_all') {
    return {
      label: label('outcome.eligibility.reaskAll', decision),
      intervention: false,
      unavailable: true,
    };
  }
  const m = /^partial:(\d+)\/(\d+)$/.exec(decision);
  if (m) {
    return {
      label: label('outcome.eligibility.partial', decision, {
        captured: Number(m[1]),
        total: Number(m[2]),
      }),
      intervention: true,
      unavailable: false,
    };
  }
  return null;
}

function outcomeFor(item: DescribableItem, decision: string): Outcome | null {
  const acted = item.acted === true;
  switch (item.check) {
    case 'triage':
      return sanitiseCodes(item.reasonCodes).includes('WATCH')
        ? watchOutcome(decision, acted)
        : triageOutcome(decision, acted);
    case 'guardrail':
      return guardrailOutcome(decision, acted, item.fallbackUsed === true);
    case 'passages':
      return passagesOutcome(decision, acted);
    case 'eligibility':
      return eligibilityOutcome(decision);
    default:
      return null;
  }
}

/** Everything the activity list needs to show one decision. */
export function describeDecision(item: DescribableItem): DecisionDescription {
  const check =
    typeof item.check === 'string' ? item.check : String(item.check);
  const decision =
    typeof item.decision === 'string' ? item.decision : String(item.decision);
  const acted = item.acted === true;
  const outcome = outcomeFor(item, decision);

  let kind: OutcomeKind;
  if (item.fallbackUsed === true || outcome?.unavailable) kind = 'unavailable';
  else if (outcome && !outcome.intervention) kind = 'passed';
  // An intervention, or a decision this file does not know yet: say
  // plainly whether it acted rather than guess that it was harmless.
  else kind = acted ? 'intervened' : 'logged';

  return {
    kind,
    // Only an intervention has an effect to report. A fallback is not
    // "logged only" even when `acted` is false: the fallback applied.
    effect:
      kind === 'intervened' ? 'acted' : kind === 'logged' ? 'logged' : null,
    check: describeCheck(check),
    outcome: outcome?.label ?? { key: null, params: {}, raw: decision },
    reasons: describeReasons(check, item.reasonCodes),
    language: describeLanguage(item.language),
  };
}

// ------------------------------------------------------------------
// Numbers
// ------------------------------------------------------------------

/**
 * Estimated spend in USD. TypeSafe calls cost fractions of a cent, so
 * small amounts keep up to four decimals ($0.0012) instead of rounding
 * to $0.00; anything too small for that reads "< $0.0001".
 */
export function formatUsd(amount: number, locale?: string): string {
  const n = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  const fmt = (min: number, max: number, value: number) =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: min,
      maximumFractionDigits: max,
    }).format(value);
  if (n > 0 && n < 0.0001) return `< ${fmt(4, 4, 0.0001)}`;
  if (n < 1) return fmt(2, 4, n);
  return fmt(2, 2, n);
}

/** Latency for display: "840 ms", "1.2 s"; null → null. */
export function formatLatency(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
