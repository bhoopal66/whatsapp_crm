/**
 * What a person has typed into a "case number" box, before any lookup.
 * Pure: it decides whether the text is worth asking the server about
 * (a full case number or a caption code whose check character holds) and
 * what to tell the person while it is not.
 */
import { parseCaption, parseCaseNumber } from './case-number';
import { caseRefOf } from './caption';

export type CaseRefState =
  /** Nothing typed. */
  | { kind: 'empty' }
  /** Could still become a reference; keep typing. */
  | { kind: 'incomplete' }
  /** Has the shape of a code, but the check character (or number) is wrong. */
  | { kind: 'bad_check' }
  /** Cannot become a reference. */
  | { kind: 'invalid' }
  /** 'TC-26-04271-RAK', ready to look up. */
  | { kind: 'case_number'; ref: string }
  /** '4271RAKD', check character verified, ready to look up. */
  | { kind: 'caption'; ref: string };

export const MAX_CASE_REF_CHARS = 40;

/** A reference as typed (spaces dropped, upper-case). */
export function normaliseCaseRef(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

export function classifyCaseRef(raw: string): CaseRefState {
  const ref = normaliseCaseRef(raw);
  if (ref === '') return { kind: 'empty' };
  if (parseCaseNumber(ref)) return { kind: 'case_number', ref };
  if (parseCaption(ref)) return { kind: 'caption', ref };
  // A reference-shaped token whose number or check does not hold.
  if (caseRefOf(ref)) return { kind: 'bad_check' };
  if (!/^[A-Z0-9-]+$/.test(ref) || ref.length > 16) return { kind: 'invalid' };
  return { kind: 'incomplete' };
}

/** Is this state one the server can be asked about? */
export function isLookupReady(
  s: CaseRefState
): s is Extract<CaseRefState, { ref: string }> {
  return s.kind === 'case_number' || s.kind === 'caption';
}
