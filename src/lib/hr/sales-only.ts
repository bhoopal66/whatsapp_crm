/**
 * Smart insights (lead signals such as Hot lead, Upset or High priority,
 * the attention pins and the customer insights card) are a sales tool.
 * The HR screens and HR chats never show them: the user's rule
 * (2026-11-16), "those are only for the sales team".
 */
export function showsSalesInsights(opts: {
  /** One of the HR inbox screens (/hr/recruiter, /hr/department, /hr/unsorted). */
  hrScreen: boolean;
  /** The open chat's `inbox_department`, when known. */
  inboxDepartment?: string | null;
}): boolean {
  return !opts.hrScreen && opts.inboxDepartment !== 'hr';
}
