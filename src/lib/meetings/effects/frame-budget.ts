// How hard the effect may work on this machine. Pure: the processor
// feeds it each frame's cost and obeys the answer.

export const TARGET_FPS = 24;
export const REDUCED_FPS = 15;
export const DROP_ABOVE_MS = 35;
/** Below the drop line, so a cost near it cannot flap the frame rate. */
export const RECOVER_BELOW_MS = 25;
export const RECOVER_AFTER_MS = 2000;
/**
 * Finding the person is the expensive step, and a person barely moves
 * between frames: above this, the last mask is reused for MASK_EVERY_BUSY
 * frames. That is what keeps a slow laptop in the meeting; giving up,
 * which turns the camera off, is only for a machine that cannot manage
 * even then.
 */
export const REUSE_MASK_ABOVE_MS = 60;
/** Well below the line, since reusing the mask is itself what lowers it. */
export const FRESH_MASK_BELOW_MS = 12;
export const MASK_EVERY_BUSY = 3;
export const GIVE_UP_ABOVE_MS = 90;
/** Slow frames expose nothing, so waiting costs only some stutter. */
export const GIVE_UP_AFTER_MS = 10_000;
const SMOOTHING = 0.2;

export interface BudgetState {
  fps: number;
  /** Find the person on every Nth frame, reusing the mask in between. */
  maskEvery: number;
  /** Rolling cost; null before the first frame. */
  avgMs: number | null;
  calmSince: number | null;
  overSince: number | null;
}

export const initialBudget = (): BudgetState => ({
  fps: TARGET_FPS,
  maskEvery: 1,
  avgMs: null,
  calmSince: null,
  overSince: null,
});

export function stepBudget(state: BudgetState, frameMs: number, nowMs: number) {
  const avgMs =
    state.avgMs === null
      ? frameMs
      : state.avgMs + SMOOTHING * (frameMs - state.avgMs);
  const calmSince =
    avgMs < RECOVER_BELOW_MS ? (state.calmSince ?? nowMs) : null;
  const calm = calmSince !== null && nowMs - calmSince >= RECOVER_AFTER_MS;
  let fps = state.fps;
  if (avgMs > DROP_ABOVE_MS) fps = REDUCED_FPS;
  else if (calm) fps = TARGET_FPS;
  let maskEvery = state.maskEvery;
  if (avgMs > REUSE_MASK_ABOVE_MS) maskEvery = MASK_EVERY_BUSY;
  else if (calm && avgMs < FRESH_MASK_BELOW_MS) maskEvery = 1;
  // The clock runs only once the cheaper way has been tried.
  const overSince =
    avgMs > GIVE_UP_ABOVE_MS && state.maskEvery > 1
      ? (state.overSince ?? nowMs)
      : null;
  const giveUp = overSince !== null && nowMs - overSince >= GIVE_UP_AFTER_MS;
  return {
    state: { fps, maskEvery, avgMs, calmSince, overSince },
    fps,
    giveUp,
  };
}
