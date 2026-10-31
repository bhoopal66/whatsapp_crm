import type { Pipeline, PipelineStage } from '@/types';

/**
 * Which stages the Pipelines screen shows, worked out from the pipeline
 * list (stages embedded) the session cache holds. Pure, so the rules are
 * tested without a browser.
 */

export type PipelineWithStages = Pipeline & {
  pipeline_stages?: PipelineStage[] | null;
};

/** The pipeline list and each pipeline's stages, from one read. */
export function splitPipelineRows(rows: readonly PipelineWithStages[]): {
  pipelines: Pipeline[];
  stagesByPipeline: Map<string, PipelineStage[]>;
} {
  const stagesByPipeline = new Map<string, PipelineStage[]>();
  const pipelines = rows.map(({ pipeline_stages, ...p }) => {
    stagesByPipeline.set(p.id, pipeline_stages ?? []);
    return p as Pipeline;
  });
  return { pipelines, stagesByPipeline };
}

/**
 * The pipeline on screen: the one chosen while it still exists, else
 * the first (also after the chosen one was deleted), else none ('').
 */
export function resolveSelectedPipeline(
  chosenId: string,
  pipelines: readonly Pick<Pipeline, 'id'>[]
): string {
  if (chosenId && pipelines.some((p) => p.id === chosenId)) return chosenId;
  return pipelines[0]?.id ?? '';
}

/**
 * The board's columns. The board files each deal under its `stage_id`,
 * so a deal on a stage the held list does not have yet (another admin
 * added it, and the deals answered before the list) would not be drawn
 * at all. Such a deal gets a column of its own, after the known ones,
 * named `placeholderName` until the list is read again; its id is the
 * real stage id, so a drop onto it is still a valid move.
 * `unknownStageIds` tells the screen to re-read the list.
 */
export function boardStages(
  stages: readonly PipelineStage[],
  deals: readonly { stage_id: string; pipeline_id?: string }[],
  placeholderName: string
): { stages: PipelineStage[]; unknownStageIds: string[] } {
  const known = new Set(stages.map((s) => s.id));
  const unknownStageIds: string[] = [];
  for (const d of deals) {
    if (known.has(d.stage_id)) continue;
    known.add(d.stage_id);
    unknownStageIds.push(d.stage_id);
  }
  if (unknownStageIds.length === 0) {
    return { stages: [...stages], unknownStageIds };
  }
  const after = stages.reduce((max, s) => Math.max(max, s.position), -1) + 1;
  const pipelineId = stages[0]?.pipeline_id ?? deals[0]?.pipeline_id ?? '';
  const placeholders = unknownStageIds.map((id, i): PipelineStage => ({
    id,
    pipeline_id: pipelineId,
    name: placeholderName,
    position: after + i,
    color: '#94a3b8',
    auto_chat_tag_id: null,
    created_at: '',
  }));
  return { stages: [...stages, ...placeholders], unknownStageIds };
}

/**
 * When to re-read the pipeline list for deals on unknown stages: once
 * per distinct set (`lastAttempt` is the previous answer), so a stage
 * the list still lacks after the re-read cannot start a loop. Null =
 * nothing to do.
 */
export function unknownStagesRefreshKey(
  unknownStageIds: readonly string[],
  lastAttempt: string | null
): string | null {
  if (unknownStageIds.length === 0) return null;
  const key = [...unknownStageIds].sort().join(',');
  return key === lastAttempt ? null : key;
}
