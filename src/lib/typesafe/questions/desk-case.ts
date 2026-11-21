/**
 * Desk case suggestion (migration 235, lib/desk/suggest.ts): which of a
 * tray document's candidate cases it most likely belongs to. Advice only:
 * the person chooses and files; nothing is filed from this answer.
 *
 * Not a safety check: no account switch, policy or ts_decision_log row.
 * Candidates are offered by ordinal (`c1 … cN`) and described only by
 * bank, product and the documents each still needs; no company or person
 * names and no ids ever reach the state.
 *
 * Wording is literal by design. Changing any wording here means a new
 * DESK_CASE_QS_VERSION.
 */
import { choice } from '@typesafe-ai/sdk';

export const DESK_CASE_QS_VERSION = 'qs-desk-case-v1';

/** Candidates offered in one request. */
export const DESK_CASE_MAX_CANDIDATES = 6;

function caseQuestion(n: number) {
  const options: Record<string, string> = {};
  for (let k = 1; k <= n; k++)
    options[`c${k}`] = `the case listed as c${k} in \`cases\``;
  options.unsure =
    'cannot tell: the document could belong to more than one of them, or to none';
  return choice(
    '`document` describes one file a customer sent on WhatsApp (its type, its file name and the caption they wrote). `cases` lists the open bank applications it may belong to, each with its bank, product and the documents that application still needs. Which single case is this document for?',
    options
  );
}

export function buildDeskCaseQuestions(n: number) {
  return { case: caseQuestion(Math.min(n, DESK_CASE_MAX_CANDIDATES)) };
}

export interface DeskCaseState {
  document: { kind: string; type: string; file_name: string; caption: string };
  cases: Record<
    string,
    { bank: string; product: string; still_needs: string[] }
  >;
  // index signature so the object satisfies the SDK's JSON state type
  [key: string]: unknown;
}
