// How hard the effect may work on this machine. Pure: the processor
// feeds it each frame's cost and obeys the answer.

export const TARGET_FPS = 24;
export const REDUCED_FPS = 15;
export const DROP_ABOVE_MS = 35;
/** Below the drop line, so a cost near it cannot flap the frame rate. */
export const RECOVER_BELOW_MS = 25;
export const RECOVER_AFTER_MS = 2000;
export const GIVE_UP_ABOVE_MS = 90;
export const GIVE_UP_AFTER_MS = 6000;
const SMOOTHING = 0.2;

export interface BudgetState {
  fps: number;
  /** Rolling cost; null before the first frame. */
  avgMs: number | null;
  calmSince: number | null;
  overSince: number | null;
}

export const initialBudget = (): BudgetState => ({
  fps: TARGET_FPS,
  avgMs: null,
  calmSince: null,
  overSince: null,
});

export function stepBudget(state: BudgetState, frameMs: number, nowMs: number) {
  const avgMs =
    state.avgMs === null
      ? frameMs
      : state.avgMs + SMOOTHING * (frameMs - state.avgMs);
  const overSince =
    avgMs > GIVE_UP_ABOVE_MS ? (state.overSince ?? nowMs) : null;
  const calmSince =
    avgMs < RECOVER_BELOW_MS ? (state.calmSince ?? nowMs) : null;
  let fps = state.fps;
  if (avgMs > DROP_ABOVE_MS) fps = REDUCED_FPS;
  else if (calmSince !== null && nowMs - calmSince >= RECOVER_AFTER_MS)
    fps = TARGET_FPS;
  const giveUp = overSince !== null && nowMs - overSince >= GIVE_UP_AFTER_MS;
  return { state: { fps, avgMs, calmSince, overSince }, fps, giveUp };
}
