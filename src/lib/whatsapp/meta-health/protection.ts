/**
 * Number protection settings and the decision log, as the settings card
 * and its route need them (188's meta_protection_settings, 334's caps
 * and send_protection_decisions). Pure: no I/O.
 */
import { GUARD_REASONS, type GuardReason } from './guard';

export const RECENT_DECISIONS = 50;

/** 188's daily_marketing_cap is an integer column. */
export const INT4_MAX = 2_147_483_647;

const REASONS = new Set<string>(Object.values(GUARD_REASONS));

/** A stored reason the card has words for; null for anything else. */
export function knownReason(raw: unknown): GuardReason | null {
  return typeof raw === 'string' && REASONS.has(raw)
    ? (raw as GuardReason)
    : null;
}

export type DecisionRow = {
  id: number;
  at: string;
  decision: 'ALLOW' | 'DENY' | 'DEFER';
  reason: string;
  template: string | null;
  enforced: boolean;
};

const DECISIONS = new Set(['ALLOW', 'DENY', 'DEFER']);

/** Rows from send_protection_decisions; malformed rows are dropped. */
export function parseDecisions(raw: unknown): DecisionRow[] {
  if (!Array.isArray(raw)) return [];
  const out: DecisionRow[] = [];
  for (const r of raw as (Record<string, unknown> | null)[]) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.at !== 'string' || typeof r.reason !== 'string') continue;
    if (typeof r.decision !== 'string' || !DECISIONS.has(r.decision)) continue;
    out.push({
      id: Number(r.id),
      at: r.at,
      decision: r.decision as DecisionRow['decision'],
      reason: r.reason,
      template: typeof r.template === 'string' ? r.template : null,
      enforced: r.enforced === true,
    });
  }
  return out;
}

const MICROS = 1_000_000;

/**
 * A spend cap typed in currency units ("12.5") → integer micros.
 * Empty → null (no cap). Up to six decimals; anything else is invalid.
 * Done on the digits, not in floating point, so "0.29" is 290000.
 */
export function unitsToMicros(
  input: string
): { ok: true; micros: number | null } | { ok: false } {
  const s = input.trim();
  if (s === '') return { ok: true, micros: null };
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return { ok: false };
  const micros = Number(m[1]) * MICROS + Number((m[2] ?? '').padEnd(6, '0'));
  return Number.isSafeInteger(micros) ? { ok: true, micros } : { ok: false };
}

/** Stored micros → the text the field starts with ('' = no cap). */
export function microsToUnits(micros: number | null): string {
  if (micros === null) return '';
  const whole = Math.floor(micros / MICROS);
  const frac = String(micros % MICROS)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/** The daily marketing count cap: empty → null; a whole number ≥ 0. */
export function parseCountCap(
  input: string
): { ok: true; cap: number | null } | { ok: false } {
  const s = input.trim();
  if (s === '') return { ok: true, cap: null };
  if (!/^\d+$/.test(s)) return { ok: false };
  const cap = Number(s);
  return cap <= INT4_MAX ? { ok: true, cap } : { ok: false };
}

/** A cap the route accepts: null, or a non-negative safe integer ≤ max. */
export function isCapValue(
  v: unknown,
  max = Number.MAX_SAFE_INTEGER
): v is number | null {
  return (
    v === null ||
    (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max)
  );
}

/** Stored micros (bigint arrives as number or string) → number | null. */
export function readMicros(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
