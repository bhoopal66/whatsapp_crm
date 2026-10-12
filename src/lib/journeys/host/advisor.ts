/**
 * Which ADVISOR decisions a journey file in `state` handles — the
 * engine's own lookup (globalAdvisor, then the PARKED reason's
 * handlers, then the state's), so a screen offers only decisions that
 * change something. A closed (terminal) or not-yet-started file
 * handles none.
 */
import type { WorkflowDef } from '../schema';
import { NEW_STATE, type AdvisorDecision } from '../types';

export function advisorDecisionsFor(
  def: WorkflowDef,
  state: string,
  parkedReason?: string | null
): AdvisorDecision[] {
  const sd = def.states[state];
  if (state === NEW_STATE || !sd || sd.terminal) return [];
  const byReason = parkedReason ? sd.byReason?.[parkedReason] : undefined;
  return [
    ...new Set([
      ...Object.keys(def.globalAdvisor),
      ...Object.keys(byReason?.advisor ?? {}),
      ...Object.keys(sd.advisor ?? {}),
    ]),
  ] as AdvisorDecision[];
}
