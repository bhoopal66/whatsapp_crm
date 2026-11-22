/**
 * The Cases list's search box (`q`): finds a case by its number
 * (TC-YY-NNNNN-BBB), its caption code (1RAK1) or the customer's name.
 * Pure matching; the route pages the inbox and keeps the matches.
 */

import { captionCodeOf, parseCaption } from '@/lib/desk/case-number';

export const SEARCH_MAX_LENGTH = 100;

/** The trimmed query, or null when empty. Over-long text is cut. */
export function readSearchQuery(raw: string | null | undefined): string | null {
  const q = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, SEARCH_MAX_LENGTH);
  return q === '' ? null : q;
}

export interface SearchableCase {
  caseNumber: string | null;
  contactName: string | null;
  contactOwnName: string | null;
  submissionRef: string | null;
}

const fold = (s: string | null | undefined) =>
  (s ?? '').toLocaleLowerCase().normalize('NFKC');

/**
 * Whether a case answers the query. A caption code (check character
 * valid) matches that case's caption exactly; a full case number matches
 * exactly; otherwise the text is a case-insensitive substring of the case
 * number, the customer's name (contact or CRM own name) or the
 * submission reference.
 */
export function caseMatchesQuery(q: string, c: SearchableCase): boolean {
  const needle = fold(q);
  if (needle === '') return true;

  const caption = parseCaption(q);
  if (caption && c.caseNumber) {
    const mine = captionCodeOf(c.caseNumber);
    if (mine && mine === `${caption.seq}${caption.bankPart}${caption.check}`)
      return true;
  }
  if (c.caseNumber && fold(c.caseNumber) === needle) return true;

  return [c.caseNumber, c.contactName, c.contactOwnName, c.submissionRef].some(
    (v) => fold(v).includes(needle)
  );
}
