/**
 * The learned skill list as the settings panel shows it (migration 290
 * §5). Dependency-free: the client component imports it.
 */

export type SkillViewKind = 'general' | 'category' | 'mistake';

export interface SkillView {
  id: string;
  kind: SkillViewKind;
  category: string | null;
  title: string;
  principle: string;
  whenToApply: string | null;
  status: 'active' | 'retired';
  evidenceCount: number;
  createdAt: string;
}

const KINDS: readonly string[] = ['general', 'category', 'mistake'];
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);

/** Rows (snake_case, from the API or the database) as views; rows
 *  missing an id, a title or a principle are dropped. Active first. */
export function parseSkillList(json: unknown): SkillView[] {
  if (!Array.isArray(json)) return [];
  const out: SkillView[] = [];
  for (const item of json) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    const id = str(v.id);
    const title = str(v.title);
    const principle = str(v.principle);
    if (!id || !title || !principle || !KINDS.includes(String(v.kind)))
      continue;
    out.push({
      id,
      kind: v.kind as SkillViewKind,
      category: str(v.category),
      title,
      principle,
      whenToApply: str(v.when_to_apply ?? v.whenToApply),
      status: v.status === 'retired' ? 'retired' : 'active',
      evidenceCount:
        typeof (v.evidence_count ?? v.evidenceCount) === 'number'
          ? Number(v.evidence_count ?? v.evidenceCount)
          : 1,
      createdAt: str(v.created_at ?? v.createdAt) ?? '',
    });
  }
  return sortSkills(out);
}

/** Active rules first; the order within each group is kept. */
export function sortSkills(list: readonly SkillView[]): SkillView[] {
  return [...list].sort(
    (a, b) => Number(a.status === 'retired') - Number(b.status === 'retired')
  );
}

/** The catalogue key (`KbLearn.skills.*`) that explains a refused
 *  retire/restore. The server's own wording is English and generic, so
 *  the screen goes by status: 409 is the active-rule cap, 404 a rule that
 *  is gone (or not the caller's to change). */
export function skillSaveFailureKey(
  status: number | null
): 'capReached' | 'gone' | 'saveFailed' {
  if (status === 409) return 'capReached';
  if (status === 404) return 'gone';
  return 'saveFailed';
}
