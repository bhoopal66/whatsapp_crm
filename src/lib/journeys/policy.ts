/** §5 send policy: windows and billing. */
import type { Category, WorkflowDef } from './schema';
import type { JourneyFile } from './types';
import { toMs } from './time';

export interface WindowState {
  inService: boolean;
  inFreeEntry: boolean;
  open: boolean;
}

export function windowState(
  w: JourneyFile['window'],
  now: string,
  windows: WorkflowDef['windows']
): WindowState {
  const t = toMs(now);
  const inService =
    w.lastInboundAt !== null &&
    t < toMs(w.lastInboundAt) + windows.serviceHours * 3_600_000;
  const inFreeEntry = w.freeEntryUntil !== null && t < toMs(w.freeEntryUntil);
  return { inService, inFreeEntry, open: inService || inFreeEntry };
}

/** Free when SESSION, inside the 72h free-entry window, or UTILITY inside the 24h service window. */
export function isBillable(category: Category, ws: WindowState): boolean {
  if (category === 'SESSION') return false;
  if (ws.inFreeEntry) return false;
  if (category === 'UTILITY' && ws.inService) return false;
  return true;
}
