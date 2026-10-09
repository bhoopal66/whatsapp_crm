/**
 * Which `pipeline_stages.auto_chat_tag_id` writes a settings save owes
 * (migration 080). The column is deliberately not part of the bulk stage
 * upsert (supabase-js would null it on rows missing it), so changed links
 * are written one stage at a time.
 *
 * Order matters: a tag may belong to at most one stage per pipeline (a
 * partial unique index, 23505). Moving a tag between stages, or swapping
 * two, would trip it mid-way if a set ran before the clear of the stage
 * that still held the tag. So every changed stage that had a link is
 * cleared first, then the new links are set.
 */

export interface StageTagLink {
  id: string;
  auto_chat_tag_id?: string | null;
}

export interface StageTagUpdate {
  stageId: string;
  tagId: string | null;
}

export function stageTagLinkUpdates(
  original: readonly StageTagLink[],
  edited: readonly StageTagLink[]
): StageTagUpdate[] {
  const before = new Map(
    original.map((s) => [s.id, s.auto_chat_tag_id ?? null])
  );
  const clears: StageTagUpdate[] = [];
  const sets: StageTagUpdate[] = [];
  for (const stage of edited) {
    // A stage absent from `original` was inserted this session, empty.
    const was = before.get(stage.id) ?? null;
    const now = stage.auto_chat_tag_id ?? null;
    if (was === now) continue;
    if (was !== null) clears.push({ stageId: stage.id, tagId: null });
    if (now !== null) sets.push({ stageId: stage.id, tagId: now });
  }
  return [...clears, ...sets];
}
