/**
 * Supabase host adapters for the journey engine (migration 086). Kept out
 * of `src/lib/journeys/index.ts` so the engine barrel stays free of I/O.
 */
export {
  SupabaseJourneyStore,
  ensureOpenFile,
  rpcScalar,
  JourneyDbError,
  type OpenFileInit,
} from './store';
export { SupabaseConsentPort } from './consent';
export { advisorDecisionsFor } from './advisor';
export {
  dispatchInboundToJourney,
  journeyEventFor,
  type JourneyInboundArgs,
} from './inbound';
export type {
  CommitResult,
  ConsentPort,
  JourneyStore,
  OutboxItem,
} from '../ports';
