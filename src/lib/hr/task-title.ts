/**
 * Which title an HR task shows. Migration 335 snapshots a rule's Arabic
 * title into the task as `meta.hr_title_ar`; an Arabic viewer reads it
 * when it is set, everyone else (and every older task) reads `title`.
 */
const pick = (title: string, ar: unknown, locale: string): string =>
  locale === 'ar' && typeof ar === 'string' && ar.trim() !== '' ? ar : title;

export function hrTaskTitle(
  task: { title: string; meta?: Record<string, unknown> | null },
  locale: string
): string {
  return pick(task.title, task.meta?.hr_title_ar, locale);
}

/** The same choice for a rule's own title on the Rules page. */
export function hrRuleTitle(
  rule: { title: string | null; title_ar?: string | null },
  locale: string
): string {
  return pick(rule.title ?? '', rule.title_ar, locale);
}
