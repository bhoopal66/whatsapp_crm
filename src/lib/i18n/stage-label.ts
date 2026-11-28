/**
 * Built-in stage names, shown in the person's language.
 *
 * A stage is stored under its English name and stays stored that way:
 * filters, rules, exports (`lib/csv/build.ts`), the API and WhatsApp
 * messages all see the stored name. Only what is put on screen goes
 * through `stageLabel`, which swaps a built-in name for its
 * `StageNames.*` catalogue string. A name the team typed or renamed is
 * not built-in and is shown exactly as typed.
 *
 * Neither table has a key column, so a built-in is recognised by its
 * seeded English name: exact case, blanks at either end ignored. The
 * seeds are the pipelines page's `SPEC_DEFAULT_STAGES` and 130's
 * `case_default_stages()` (`DEFAULT_STAGES` in `lib/cases/ui.ts`);
 * stage-label.test.ts keeps this table equal to both.
 */

/** Seeded English name -> key under `StageNames` in `messages/*.json`. */
export const BUILT_IN_STAGE_KEYS: Readonly<Record<string, string>> = {
  // Default pipeline (pipelines page, SPEC_DEFAULT_STAGES).
  'New Lead': 'newLead',
  Qualified: 'qualified',
  'Proposal Sent': 'proposalSent',
  Negotiation: 'negotiation',
  Won: 'won',
  // Case stages (130's case_default_stages()).
  Interested: 'interested',
  'Data collection': 'dataCollection',
  Review: 'review',
  Submitted: 'submitted',
  'Bank acknowledged': 'bankAcknowledged',
  'Documents requested': 'documentsRequested',
  'Documents received': 'documentsReceived',
  'Under review': 'underReview',
  'Query raised': 'queryRaised',
  'Query answered': 'queryAnswered',
  Approved: 'approved',
  Declined: 'declined',
  Withdrawn: 'withdrawn',
  Closed: 'closed',
};

/** A translator for the `StageNames` namespace (`useTranslations('StageNames')`). */
export type StageTranslator = (key: string) => string;

/** What to show for a stage name: the catalogue string for a built-in, else the name as given. */
export function stageLabel(name: string, t: StageTranslator): string;
export function stageLabel(
  name: string | null | undefined,
  t: StageTranslator
): string | null | undefined;
export function stageLabel(
  name: string | null | undefined,
  t: StageTranslator
): string | null | undefined {
  if (!name) return name;
  const trimmed = name.trim();
  if (!Object.hasOwn(BUILT_IN_STAGE_KEYS, trimmed)) return name;
  return t(BUILT_IN_STAGE_KEYS[trimmed]);
}
