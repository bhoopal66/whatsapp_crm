/**
 * The tray's "Find case": a case number or code is one lookup; anything
 * else is a customer-name (or licence) search over the companies the
 * person may read, expanded to their open cases. Pure helpers only; the
 * calls are the desk API's, which enforce access.
 */
import { classifyCaseRef, isLookupReady } from './case-ref';
import type { DeskCompany } from './companies';
import type { CompanyOverview } from './shared-docs';
import type { CaseLookup } from './store';
import type { TrayCandidate } from './tray';

export const MIN_NAME_CHARS = 2;
/** At most this many companies are expanded to their cases per search. */
export const MAX_COMPANIES = 5;

export type SearchKind = 'ref' | 'name' | 'short';

export function classifySearch(raw: string): SearchKind {
  const q = raw.trim();
  if (isLookupReady(classifyCaseRef(q))) return 'ref';
  return q.length >= MIN_NAME_CHARS ? 'name' : 'short';
}

/** A looked-up case as a tray candidate (found by search, no "why"). */
export function lookupToCandidate(l: CaseLookup): TrayCandidate {
  return {
    caseId: l.caseId,
    caseNumber: l.caseNumber,
    bankCode: l.bankCode ?? '',
    company: l.companyName ?? '',
    product: l.product,
    why: [],
  };
}

/** A company's open cases the person can write, as candidates. */
export function overviewToCandidates(
  company: Pick<DeskCompany, 'legalName'>,
  o: Pick<CompanyOverview, 'cases'>
): TrayCandidate[] {
  return o.cases
    .filter((c) => !c.closed && c.canWrite && c.caseNumber !== null)
    .map((c) => ({
      caseId: c.caseId,
      caseNumber: c.caseNumber,
      bankCode: c.bankCode,
      company: company.legalName,
      product: c.product,
      why: [],
    }));
}

/** The item's own candidates first, then the found ones, once per case. */
export function mergeCandidates(
  base: readonly TrayCandidate[],
  found: readonly TrayCandidate[]
): TrayCandidate[] {
  const seen = new Set<string>();
  const out: TrayCandidate[] = [];
  for (const c of [...base, ...found]) {
    if (seen.has(c.caseId)) continue;
    seen.add(c.caseId);
    out.push(c);
  }
  return out;
}
