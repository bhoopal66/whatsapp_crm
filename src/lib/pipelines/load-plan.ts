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
// Two caches, two rules (see client-cache.ts and session-cache.ts):
// - pipelines and stages are reference data: `cachedQuery`, keys that
//   name the account / the pipeline, invalidated by this screen's
//   own edits.
// - deals are screen data: session cache, shown at once and always
//   revalidated. The key names the pipeline and the owner filter.
// ============================================================

/** Prefix of every cached pipeline list, for blanket invalidation. */
export const PIPELINES_CACHE_PREFIX = 'pipelines:';

/** The pipeline list (stages embedded) of an account. */
export function pipelinesCacheKey(accountId: string): string {
  return `${PIPELINES_CACHE_PREFIX}${accountId}`;
}

/** The stages of one pipeline. */
export function stagesCacheKey(pipelineId: string): string {
  return `stages:${pipelineId}`;
}

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
