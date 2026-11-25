/**
 * The learned skill list as the settings panel shows it (migration 318
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
