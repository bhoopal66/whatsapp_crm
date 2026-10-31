// ============================================================
// How the Pipelines screen loads: cache keys and the first wave.
//
// Every browser round trip is ~0.4-0.7 s through the tunnel, so the
// screen asks for everything it can in one wave. The pipeline list
// is fetched with its stages embedded (one query), so the only other
// thing worth starting early is the deals of the pipeline the user
// had open last time (the "guess"); a guess that turns out wrong
// falls back to loading the right pipeline's stages and deals.
//
// Both are screen data in the session cache (session-cache.ts): shown
// at once from the last visit and always revalidated, so a stage or
// pipeline another admin added is on the board the next time it is
// shown. The pipeline list carries every stage, so stage and pipeline
// edits refresh that one entry. Deals are keyed by pipeline and owner
// filter.
// ============================================================

/** The session-cache question for the pipeline list (stages embedded). */
export const PIPELINES_QUESTION = 'pipelines:list';

/**
 * The session-cache question for a board's deals. `ownerFilter` is the
 * PostgREST `or(...)` string (null = everyone the caller may see); it
 * changes the answer, so it is part of the key.
 */
export function dealsQuestion(
  pipelineId: string,
  ownerFilter: string | null
): string {
  return `pipelines:deals:${pipelineId}:${ownerFilter ?? 'all'}`;
}

export interface FirstWavePlan {
  /** Pipeline whose deals to request alongside the pipeline list. */
  dealsFor: string | null;
}

/**
 * What to start before the pipeline list has answered. Only the default
 * (unfiltered) view is guessed: with an owner filter the guess would be
 * the wrong question.
 */
export function planFirstWave(
  guess: string | null,
  ownerFilter: string | null
): FirstWavePlan {
  return { dealsFor: guess && !ownerFilter ? guess : null };
}

/**
 * Whether a speculatively started deals request answers the question
 * the screen now asks (same pipeline, same unfiltered view).
 */
export function canUseSpeculativeDeals(
  started: { id: string } | null,
  pipelineId: string,
  ownerFilter: string | null
): boolean {
  return started !== null && started.id === pipelineId && !ownerFilter;
}
